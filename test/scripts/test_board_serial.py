"""
Tests for scripts/lib/board_serial.py, against a simulated board.

FakeBoard plays the firmware's side of the serial link on a pseudo-terminal:
what CloudAgenticDevice.cpp prints, and how it reads. It looks for input every
50 ms and holds at most 384 bytes in between (the ESP32's 256-byte receive
buffer and 128-byte FIFO), so a bundle sent in one burst loses characters as
it can on a real board. Once a line starts arriving it reads as fast as bytes
come, with Stream's one-second timeout between them. It starts when the
helper opens the port, as the real board restarts then, and it records any
byte that reaches it before it has asked for one.

A UART thread drains the pseudo-terminal the moment bytes arrive, into a
receive buffer that drops what does not fit while the firmware is not reading.
So a burst is lost the same way on every OS, however the kernel chunks it: a
pseudo-terminal delivers it far faster than 115200 baud, and the end is
rejected. On a real board the end arrives
after the firmware starts reading, so the line can lose a piece from inside
the certificate and still be stored. Either way the bundle does not arrive
whole, which is what the burst test checks.

Each test runs the helper as the shell scripts do, as its own process, with
its waits shortened. A pseudo-terminal has no RTS line, so the helper cannot
restart the board itself: these tests exercise the path where the person
presses EN, and press it when the helper asks.

Run with: python3 -m unittest discover -s test/scripts
"""

import importlib.util
import json
import os
import pty
import select
import subprocess
import sys
import tempfile
import termios
import threading
import time
import tty
import unittest
from unittest import mock

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
HELPER = os.path.join(REPO, 'scripts', 'lib', 'board_serial.py')

CERT = ('-----BEGIN CERTIFICATE-----\n'
        + ('MIIDWTCCAkGgAwIBAgIUQfakeCertificateBodyForTestsOnly0123456789ab\n' * 19)
        + '-----END CERTIFICATE-----\n')
KEY = ('-----BEGIN RSA PRIVATE KEY-----\n'
       + ('MIIEowIBAAKCAQEAfakeKeyBodyForTestsOnlyNeverARealKey0123456789xy\n' * 25)
       + '-----END RSA PRIVATE KEY-----\n')
PASSPHRASE = 'not-a-real-passphrase'

BUNDLE = {
    'thingName': 'CompanyInternalESP32',
    'endpoint': 'a1b2c3d4e5f6g7-ats.iot.us-east-2.amazonaws.com',
    'ssid': 'Home',
    'passphrase': PASSPHRASE,
    'certificatePem': CERT,
    'privateKey': KEY,
}

IDENTITY = {k: BUNDLE[k] for k in ('thingName', 'endpoint', 'certificatePem', 'privateKey')}


class Restart(Exception):
    """The board restarted: EN was pressed, or the firmware called ESP.restart()."""


class FakeBoard:
    RX_ROOM = 384

    def __init__(self, master, identity=None, networks=(), working=('Home',), aws_ok=True,
                 starts='on-open', damage_first_bundle=False, unplugged_after_prompt=False,
                 keeps_nothing=False):
        self.master = master
        self.identity = dict(identity or {})
        self.networks = [(ssid, 'x') for ssid in networks]
        self.working = set(working)
        self.aws_ok = aws_ok
        self.starts = starts
        self.damage_next_bundle = damage_first_bundle
        self.unplugged_after_prompt = unplugged_after_prompt
        self.unplugged = False
        self.keeps_nothing = keeps_nothing
        self.early = b''             # bytes that reached it before it asked for any
        self._power = threading.Event()
        self.lines_read = []
        self.boots = 0
        self.rx = b''
        self._uart = b''             # the ESP32's receive buffer, filled by _drain
        self._reading = False        # inside readStringUntil: nothing overflows
        self._uart_lock = threading.Condition()
        self._en = threading.Event()
        self._stopping = False
        os.set_blocking(master, False)
        self.thread = threading.Thread(target=self._run, daemon=True)
        self.thread.start()
        self._drainer = threading.Thread(target=self._drain, daemon=True)
        self._drainer.start()

    def press_en(self):
        self._en.set()

    def port_opened(self):
        self._power.set()

    def stop(self):
        self._stopping = True
        self._power.set()
        self._en.set()
        self.thread.join(5)
        self._drainer.join(5)

    # ------------------------------------------------------------ plumbing

    def _run(self):
        quiet = self.starts == 'quiet'
        if self.starts == 'on-open':
            self._power.wait()        # the restart that opening the port causes
        while not self._stopping:
            self._en.clear()
            try:
                if quiet:
                    quiet = False
                    self._loop()      # running for a while already: says nothing until spoken to
                self._boot()
            except Restart:
                continue
            except OSError:
                return                # the test closed the pseudo-terminal

    def _sleep(self, seconds):
        if self._en.wait(seconds):
            raise Restart()

    def _write(self, data):
        while data:
            try:
                data = data[os.write(self.master, data):]
            except BlockingIOError:
                self._sleep(0.01)

    def _print(self, text):
        self._write(text.encode('utf-8'))

    def _println(self, text):
        self._print(text + '\r\n')

    def _drain(self):
        # The UART: takes bytes off the wire as they arrive, whatever the
        # firmware is doing. While the firmware is not reading, what does not
        # fit in RX_ROOM is lost, as on the chip.
        while not self._stopping:
            try:
                if not select.select([self.master], [], [], 0.02)[0]:
                    continue
                chunk = os.read(self.master, 65536)
            except BlockingIOError:
                continue
            except (OSError, ValueError):
                return                # the test closed the pseudo-terminal
            if not chunk:
                continue
            with self._uart_lock:
                if self._reading:
                    self._uart += chunk
                else:
                    self._uart += chunk[:max(self.RX_ROOM - len(self._uart), 0)]
                self._uart_lock.notify_all()

    def _take(self):
        with self._uart_lock:
            data, self._uart = self._uart, b''
            return data

    def _readable_within(self, seconds):
        end = time.monotonic() + seconds
        while True:
            if self._en.is_set():
                raise Restart()
            left = end - time.monotonic()
            if left <= 0:
                return False
            with self._uart_lock:
                if self._uart:
                    return True
                self._uart_lock.wait(min(left, 0.02))

    # ------------------------------------------------- the firmware's reads

    def _available(self):
        # Serial.available() after a delay(50): whatever arrived while the
        # firmware was not reading, up to what the buffers hold.
        arrived = self._take()
        room = max(self.RX_ROOM - len(self.rx), 0)
        self.rx += arrived[:room]
        return bool(self.rx)

    def _read_line(self):
        # Stream::readStringUntil('\n'), with its one-second timeout.
        with self._uart_lock:
            self._reading = True
        try:
            return self._read_line_now()
        finally:
            with self._uart_lock:
                self._reading = False

    def _read_line_now(self):
        got = b''
        while True:
            if not self.rx:
                if not self._readable_within(1.0):
                    break
                self.rx += self._take()
                continue
            nl = self.rx.find(b'\n')
            if nl >= 0:
                got += self.rx[:nl]
                self.rx = self.rx[nl + 1:]
                break
            got += self.rx
            self.rx = b''
        text = got.decode('utf-8', 'replace')
        if self.damage_next_bundle and len(text) > 1000:
            self.damage_next_bundle = False
            text = text[:500]
        return text

    @staticmethod
    def _parse(line):
        # ArduinoJson 7, which firmware.sh setup installs, sizes the document
        # on the heap, so StaticJsonDocument's capacity sets no limit.
        try:
            doc = json.loads(line)
        except ValueError:
            return None
        return doc if isinstance(doc, dict) else None

    # --------------------------------------------------------- the firmware

    def _boot(self):
        self.boots += 1
        self._write(b'\xff\x00ets Jun  8 2016 00:22:57\r\n\r\n'
                    b'rst:0x1 (POWERON_RESET),boot:0x13 (SPI_FAST_FLASH_BOOT)\r\n'
                    b'\x8f\xfe\xa0\x13\x00\x11\r\n')
        self._sleep(0.05)
        self.early += self._take()  # anything sent while the ROM ran is gone
        self.rx = b''
        self._sleep(0.1)          # setup(): Serial.begin(), delay(1000), shortened
        if not all(self.identity.get(k) for k in IDENTITY):
            arrived = self._take()  # sent before the prompt: read as the start of the line
            self.early += arrived
            self.rx += arrived
            self._provision(has_identity=False)
            self._loop()
        self._println('telemetry: every 60 s')
        if not self._connect_wifi():
            self._provision(has_identity=True)
            self._loop()
        self._println('aws: connecting as ' + self.identity['thingName'])
        self._sleep(0.05)
        if self.aws_ok:
            self._println('aws: connected, patient-monitor v2.1.0')
        else:
            self._println('aws: not connected, state -2')
            self._println('aws: attempt 1 failed, next in 1873 ms')
        self._loop()

    def _provision(self, has_identity):
        self._println('')
        self._println('WIFI RECOVERY MODE - paste {"ssid":...,"passphrase":...} and press Enter:'
                      if has_identity else
                      'PROVISIONING MODE - paste the provisioning bundle and press Enter:')
        if self.unplugged_after_prompt:
            # The cable comes out: the computer's end of the port hangs up.
            self.unplugged = True
            os.close(self.master)
            raise OSError('unplugged')
        deadline = time.monotonic() + 120
        line = ''
        while time.monotonic() < deadline:
            if self._available():
                line = self._read_line().strip()
                if line:
                    break
            self._sleep(0.05)
        if not line:
            self._println('timed out')
            return
        self.lines_read.append(line)
        doc = self._parse(line)
        if doc is None:
            self._println('not valid JSON')
            return
        self._save_network(doc.get('ssid', ''), doc.get('passphrase', ''))
        if has_identity:
            self._println('identity left untouched')
        else:
            if not self.keeps_nothing:  # NVS refusing a value fails silently
                self.identity = {k: doc.get(k, '') for k in IDENTITY}
            self._println('identity stored (write-once)')
        self._println('restarting')
        self._sleep(0.1)
        raise Restart()

    def _save_network(self, ssid, passphrase):
        slots = [s for s, _ in self.networks]
        if ssid in slots:
            slot = slots.index(ssid)
            self.networks[slot] = (ssid, passphrase)
        elif len(self.networks) < 3:
            slot = len(self.networks)
            self.networks.append((ssid, passphrase))
        else:
            slot = 2
            self.networks[2] = (ssid, passphrase)
        self._println("wifi: stored '{}' in slot {}".format(ssid, slot))

    def _connect_wifi(self):
        for ssid, _ in list(self.networks):
            self._println("wifi: trying '{}'".format(ssid))
            for _ in range(3):
                self._sleep(0.03)
                self._print('.')
            if ssid in self.working:
                self._print("\nwifi: connected to '{}', ip 192.168.1.23\n".format(ssid))
                return True
            self._println('\nwifi: failed, next candidate')
        return False

    def _loop(self):
        # loop() -> checkSerialWifiUpdate(), the only reading it does.
        while True:
            if self._available():
                line = self._read_line().strip()
                if line:
                    self.lines_read.append(line)
                    doc = self._parse(line)
                    if doc is None:
                        self._println('wifi: not valid JSON, ignored')
                    elif 'ssid' not in doc:
                        self._println("wifi: no 'ssid' field, ignored")
                    else:
                        self._save_network(doc.get('ssid', ''), doc.get('passphrase', ''))
                        self._println('wifi: updated over serial - identity and certificate untouched')
            self._sleep(0.05)


class Session:
    """One run of a command against a FakeBoard, pressing EN when it asks."""

    def __init__(self, command, env=None, stdin=subprocess.DEVNULL, **board):
        master, slave = pty.openpty()
        tty.setraw(slave)
        self.port = os.ttyname(slave)
        self.board = FakeBoard(master, **board)
        environ = dict(os.environ, BOARD_SERIAL_TIME_SCALE='0.1', PYTHONUNBUFFERED='1')
        environ.update(env or {})
        proc = subprocess.Popen(command(self.port), stdin=stdin, stdout=subprocess.PIPE,
                                stderr=subprocess.STDOUT, text=True, env=environ, cwd=REPO)
        watchdog = threading.Timer(90, proc.kill)
        watchdog.start()
        self.output = []
        for line in proc.stdout:
            self.output.append(line.rstrip('\n'))
            if line.startswith('Port:'):
                self.board.port_opened()
            if 'Press the EN button' in line:
                self.board.press_en()
        proc.stdout.close()
        self.code = proc.wait()
        watchdog.cancel()
        self.board.stop()
        if not self.board.unplugged:
            os.close(master)
        os.close(slave)
        self.text = '\n'.join(self.output)


def write_bundle(directory, bundle=None, name='CompanyInternalESP32-1793925455669.json'):
    path = os.path.join(directory, name)
    with open(path, 'w') as f:
        json.dump(BUNDLE if bundle is None else bundle, f, indent=2)
    return path


class ProvisionTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.dir.cleanup)
        self.bundle = write_bundle(self.dir.name)

    def provision(self, bundle=None, **board):
        path = self.bundle if bundle is None else bundle
        return Session(lambda port: [sys.executable, HELPER, 'provision', port, path], **board)

    def assertNothingSecretShown(self, run):
        self.assertNotIn(PASSPHRASE, run.text)
        self.assertNotIn('fakeKeyBody', run.text)
        self.assertNotIn('fakeCertificateBody', run.text)

    def test_waits_for_the_prompt_then_sends_the_bundle_so_the_board_gets_it_whole(self):
        run = self.provision()
        self.assertEqual(run.code, 0, run.text)
        self.assertEqual(run.board.early, b'')
        self.assertEqual(len(run.board.lines_read), 1)
        self.assertEqual(json.loads(run.board.lines_read[0]), BUNDLE)
        self.assertEqual(run.board.identity, IDENTITY)
        self.assertIn('Online: CompanyInternalESP32 is connected to AWS IoT.', run.text)
        self.assertNothingSecretShown(run)

    def test_the_simulated_board_loses_a_bundle_sent_in_one_burst(self):
        # What the old script did, and why the helper paces itself: proof the
        # simulation is strict enough for the test above to mean something.
        master, slave = pty.openpty()
        tty.setraw(slave)
        board = FakeBoard(master, starts='booting')
        try:
            seen = b''
            end = time.monotonic() + 5
            while b'PROVISIONING MODE' not in seen and time.monotonic() < end:
                if select.select([slave], [], [], 0.1)[0]:
                    seen += os.read(slave, 4096)
            self.assertIn(b'PROVISIONING MODE', seen)
            line = json.dumps(BUNDLE, separators=(',', ':')).encode() + b'\n'
            os.write(slave, line)
            seen = b''
            end = time.monotonic() + 3
            while b'not valid JSON' not in seen and time.monotonic() < end:
                if select.select([slave], [], [], 0.1)[0]:
                    seen += os.read(slave, 4096)
            self.assertIn(b'not valid JSON', seen)
            self.assertNotEqual(board.identity, IDENTITY)
        finally:
            board.stop()
            os.close(master)
            os.close(slave)

    def test_sends_only_the_fields_the_firmware_reads(self):
        extra = dict(BUNDLE, certificateId='f3c0e560', note='x' * 2000)
        run = self.provision(bundle=write_bundle(self.dir.name, extra, 'extra.json'))
        self.assertEqual(run.code, 0, run.text)
        self.assertEqual(sorted(json.loads(run.board.lines_read[0])), sorted(BUNDLE))

    def test_asks_for_EN_when_the_board_says_nothing(self):
        run = self.provision(starts='quiet')
        self.assertEqual(run.code, 0, run.text)
        self.assertIn('Press the EN button', run.text)
        self.assertEqual(run.board.identity, IDENTITY)

    def test_sends_again_after_a_damaged_copy(self):
        run = self.provision(damage_first_bundle=True)
        self.assertEqual(run.code, 0, run.text)
        self.assertIn('Trying once more', run.text)
        self.assertEqual(len(run.board.lines_read), 2)
        self.assertEqual(run.board.identity, IDENTITY)

    def test_does_not_send_to_a_board_that_is_already_online_as_this_thing(self):
        run = self.provision(identity=IDENTITY, networks=['Home'])
        self.assertEqual(run.code, 0, run.text)
        self.assertIn('already online as CompanyInternalESP32', run.text)
        self.assertEqual(run.board.lines_read, [])

    def test_does_not_send_to_a_board_with_another_identity(self):
        run = self.provision(identity=dict(IDENTITY, thingName='Test5'), networks=['Home'])
        self.assertEqual(run.code, 2, run.text)
        self.assertIn('already has another identity, Test5', run.text)
        self.assertEqual(run.board.lines_read, [])
        self.assertEqual(run.board.identity['thingName'], 'Test5')

    def test_says_so_when_the_bundle_network_does_not_work(self):
        run = self.provision(working=())
        self.assertEqual(run.code, 3, run.text)
        self.assertEqual(run.board.identity, IDENTITY)
        self.assertIn('update-wifi.sh', run.text)

    def test_says_so_when_aws_does_not_accept_the_board(self):
        run = self.provision(aws_ok=False)
        self.assertEqual(run.code, 3, run.text)
        self.assertIn('the secure connection to the endpoint failed', run.text)

    def test_a_board_holding_this_identity_that_aws_refuses_keeps_the_bundle(self):
        run = self.provision(identity=IDENTITY, networks=['Home'], aws_ok=False)
        self.assertEqual(run.code, 4, run.text)
        self.assertIn('the secure connection to the endpoint failed', run.text)
        self.assertIn('intact copy', run.text)
        self.assertEqual(run.board.lines_read, [])

    def test_a_board_holding_an_identity_without_wifi_is_given_a_network_first(self):
        # Without Wi-Fi the board never says which Thing it is, so nothing is
        # sent and the bundle is not called unused: it may be this board's.
        script = os.path.join(REPO, 'scripts', 'provision-device.sh')
        run = Session(lambda port: ['bash', script, self.bundle, port],
                      identity=IDENTITY, networks=['Old'], working=())
        self.assertEqual(run.code, 4, run.text)
        self.assertIn('cannot say which identity', run.text)
        self.assertIn('./scripts/update-wifi.sh "<SSID>"', run.text)
        self.assertIn('Keep the bundle: the board may hold this same identity', run.text)
        self.assertNotIn('unused', run.text)
        self.assertNotIn('Delete the bundle now', run.text)
        self.assertEqual(run.board.lines_read, [])

    def test_a_board_that_restarts_without_the_bundle_kept_nothing(self):
        run = self.provision(keeps_nothing=True)
        self.assertEqual(run.code, 1, run.text)
        self.assertIn('nothing usable was stored', run.text)

    def test_refuses_a_value_too_long_for_the_board_to_store(self):
        chain = CERT * 4
        path = write_bundle(self.dir.name, dict(BUNDLE, certificatePem=chain), 'chain.json')
        result = subprocess.run([sys.executable, HELPER, 'provision', '/dev/no-such-port', path],
                                capture_output=True, text=True)
        self.assertEqual(result.returncode, 1)
        self.assertIn('stores at most 3999', result.stdout)

    def test_says_the_cable_came_out_when_the_port_hangs_up(self):
        run = self.provision(unplugged_after_prompt=True)
        self.assertEqual(run.code, 1, run.text)
        self.assertIn('Lost the connection to the board', run.text)
        self.assertNotIn('never asked for a bundle', run.text)

    def test_refuses_a_bundle_without_a_private_key_before_opening_the_port(self):
        broken = dict(BUNDLE)
        del broken['privateKey']
        path = write_bundle(self.dir.name, broken, 'broken.json')
        result = subprocess.run([sys.executable, HELPER, 'provision', '/dev/no-such-port', path],
                                capture_output=True, text=True)
        self.assertEqual(result.returncode, 1)
        self.assertIn('has no privateKey', result.stdout)

    def test_refuses_a_file_that_is_not_a_bundle(self):
        path = os.path.join(self.dir.name, 'notes.json')
        with open(path, 'w') as f:
            f.write('not json')
        result = subprocess.run([sys.executable, HELPER, 'provision', '/dev/no-such-port', path],
                                capture_output=True, text=True)
        self.assertEqual(result.returncode, 1)
        self.assertIn('not JSON', result.stdout)

    def test_names_a_missing_port(self):
        result = subprocess.run([sys.executable, HELPER, 'provision', '/dev/no-such-port', self.bundle],
                                capture_output=True, text=True)
        self.assertEqual(result.returncode, 1)
        self.assertIn('There is no /dev/no-such-port', result.stdout)

    def test_the_script_says_to_delete_the_bundle_only_once_the_board_is_online(self):
        script = os.path.join(REPO, 'scripts', 'provision-device.sh')
        online = Session(lambda port: ['bash', script, self.bundle, port])
        self.assertEqual(online.code, 0, online.text)
        self.assertIn('Delete the bundle now', online.text)
        self.assertIn('rm ' + self.bundle, online.text)

        offline = Session(lambda port: ['bash', script, self.bundle, port], working=())
        self.assertEqual(offline.code, 3, offline.text)
        self.assertNotIn('Delete the bundle now', offline.text)
        self.assertIn('Keep the bundle', offline.text)


class WifiTest(unittest.TestCase):
    def update(self, ssid='Hotspot', passphrase='hotspot-pass', **board):
        env = {'WIFI_SSID': ssid, 'WIFI_PASS': passphrase}
        return Session(lambda port: [sys.executable, HELPER, 'wifi', port], env=env, **board)

    def test_a_running_board_stores_the_network(self):
        run = self.update(identity=IDENTITY, networks=['Home'], starts='quiet')
        self.assertEqual(run.code, 0, run.text)
        self.assertEqual(run.board.lines_read, ['{"ssid":"Hotspot","passphrase":"hotspot-pass"}'])
        self.assertEqual(run.board.networks, [('Home', 'x'), ('Hotspot', 'hotspot-pass')])
        self.assertNotIn('hotspot-pass', run.text)

    def test_a_board_that_just_restarted_gets_it_once_it_can_read(self):
        run = self.update(identity=IDENTITY, networks=['Home'])
        self.assertEqual(run.code, 0, run.text)
        self.assertIn(('Hotspot', 'hotspot-pass'), run.board.networks)
        self.assertIn('identity and certificate are untouched', run.text)
        self.assertEqual(run.board.early, b'')

    def test_a_board_asking_for_wifi_gets_online_with_it(self):
        run = self.update(identity=IDENTITY, networks=['Old'], working=('Hotspot',))
        self.assertEqual(run.code, 0, run.text)
        self.assertIn('Online', run.text)

    def test_says_the_same_whether_or_not_the_board_has_an_identity(self):
        # A board whose 120 s ran out unprovisioned still reads Wi-Fi lines,
        # and one that has been online a while says nothing either: the reply
        # cannot tell them apart, so the result claims neither.
        for board in (dict(starts='quiet'), dict(identity=IDENTITY, networks=['Home'], starts='quiet')):
            run = self.update(**board)
            self.assertEqual(run.code, 0, run.text)
            self.assertIn('Stored. The board tries this network', run.text)
            self.assertNotIn('no identity', run.text)
            self.assertNotIn('keeps its identity', run.text)

    def test_a_board_asking_for_its_bundle_is_left_alone(self):
        run = self.update()
        self.assertEqual(run.code, 1, run.text)
        self.assertIn('provision-device.sh', run.text)
        self.assertEqual(run.board.lines_read, [])

    def test_the_script_passes_the_passphrase_through_the_environment(self):
        script = os.path.join(REPO, 'scripts', 'update-wifi.sh')
        run = Session(lambda port: ['bash', script, 'Hotspot', 'hotspot-pass', port],
                      identity=IDENTITY, networks=['Home'], starts='quiet')
        self.assertEqual(run.code, 0, run.text)
        self.assertIn(('Hotspot', 'hotspot-pass'), run.board.networks)

    def test_the_script_asks_for_the_passphrase_without_showing_it(self):
        script = os.path.join(REPO, 'scripts', 'update-wifi.sh')
        keyboard, terminal = pty.openpty()
        self.addCleanup(os.close, keyboard)
        self.addCleanup(os.close, terminal)

        def type_passphrase():
            # Type once the prompt has turned echo off, as a person would after
            # reading it (anything typed sooner is echoed whatever the script
            # does), or after 10 s, so a script that leaves echo on fails below.
            end = time.monotonic() + 10
            while time.monotonic() < end and termios.tcgetattr(terminal)[3] & termios.ECHO:
                time.sleep(0.02)
            os.write(keyboard, b'hotspot-pass\n')

        typist = threading.Thread(target=type_passphrase, daemon=True)
        typist.start()
        # The second argument names the port, so it is not taken for a passphrase.
        run = Session(lambda port: ['bash', script, 'Hotspot', port], stdin=terminal,
                      identity=IDENTITY, networks=['Home'], starts='quiet')
        typist.join(5)
        self.assertEqual(run.code, 0, run.text)
        self.assertIn('Passphrase for Hotspot (not shown', run.text)
        self.assertIn(('Hotspot', 'hotspot-pass'), run.board.networks)
        self.assertNotIn('hotspot-pass', run.text)
        os.set_blocking(keyboard, False)
        try:
            echoed = os.read(keyboard, 4096)
        except BlockingIOError:
            echoed = b''
        self.assertNotIn(b'hotspot-pass', echoed)

    def test_the_script_does_not_wait_for_a_passphrase_nobody_can_type(self):
        script = os.path.join(REPO, 'scripts', 'update-wifi.sh')
        result = subprocess.run(['bash', script, 'Hotspot', '/dev/no-such-port'],
                                stdin=subprocess.DEVNULL, capture_output=True, text=True)
        self.assertEqual(result.returncode, 1)
        self.assertIn('Run this in a terminal', result.stdout + result.stderr)


def load_helper():
    spec = importlib.util.spec_from_file_location('board_serial', HELPER)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class LineControlTest(unittest.TestCase):
    """What a pseudo-terminal cannot show: the RTS restart and the pacing."""

    def setUp(self):
        self.helper = load_helper()
        self.board = self.helper.Board.__new__(self.helper.Board)
        self.board.fd = 99
        self.board.pending = b'from before'
        self.calls = []

    def test_restarts_the_way_esptool_does(self):
        termios = self.helper.termios

        def ioctl(fd, request, arg=0):
            self.calls.append(('ioctl', request, arg))

        with mock.patch.object(self.helper.fcntl, 'ioctl', ioctl), \
             mock.patch.object(self.helper.termios, 'tcflush', lambda fd, q: self.calls.append(('flush',))), \
             mock.patch.object(self.helper.time, 'sleep', lambda s: None):
            self.assertTrue(self.board.restart())
        dtr = self.helper.struct.pack('I', termios.TIOCM_DTR)
        rts = self.helper.struct.pack('I', termios.TIOCM_RTS)
        self.assertEqual(self.calls, [
            ('ioctl', termios.TIOCMBIC, dtr),   # DTR released: GPIO0 stays high
            ('ioctl', termios.TIOCMBIS, rts),   # RTS asserted: EN low, the board held in reset
            ('flush',),                         # what it printed before is discarded
            ('ioctl', termios.TIOCMBIC, rts),   # RTS released: it starts its firmware
        ])
        self.assertEqual(self.board.pending, b'')

    def test_a_port_without_modem_lines_is_left_as_it_is(self):
        def ioctl(fd, request, arg=0):
            raise OSError(25, 'Inappropriate ioctl for device')

        with mock.patch.object(self.helper.fcntl, 'ioctl', ioctl):
            self.assertFalse(self.board.restart())
        self.assertEqual(self.board.pending, b'from before')

    def test_sends_in_small_pieces_with_pauses(self):
        events = []

        def write(fd, data):
            events.append(('write', bytes(data)))
            return len(data)

        with mock.patch.object(self.helper.os, 'write', write), \
             mock.patch.object(self.helper.termios, 'tcdrain', lambda fd: None), \
             mock.patch.object(self.helper.time, 'sleep', lambda s: events.append(('sleep', s))):
            data = bytes(range(256)) * 12
            self.board.send(data)
        writes = [e[1] for e in events if e[0] == 'write']
        self.assertEqual(b''.join(writes), data)
        self.assertTrue(all(len(w) <= self.helper.PIECE for w in writes))
        # Each piece is followed by a pause twice its time on the wire.
        self.assertEqual([e[0] for e in events], ['write', 'sleep'] * len(writes))
        self.assertTrue(all(e[1] >= 2 * self.helper.PIECE / 11520 for e in events if e[0] == 'sleep'))


if __name__ == '__main__':
    unittest.main()
