#!/usr/bin/env python3
"""
board_serial.py - talks to an ESP32 running our firmware over its USB serial
port. scripts/provision-device.sh, update-wifi.sh and setup-device.sh use it.

    board_serial.py provision <port> <bundle.json>
    board_serial.py wifi <port>      (WIFI_SSID and WIFI_PASS in the environment)

Why this is more than `printf ... > /dev/cu.usbserial-0001`:

- The firmware asks for its provisioning bundle for 120 seconds after it
  starts, and only then. A bundle sent later goes to its Wi-Fi update reader,
  which at most stores the bundle's network. So this restarts the board the
  way esptool does and sends the bundle only once the board has printed its
  prompt.
- The firmware looks for input every 50 ms, and the ESP32 holds only a few
  hundred bytes in between. A bundle is about 3 KB, so one sent in a single
  burst can lose characters. A loss inside the certificate or the key still
  parses as JSON, and the board keeps the first identity it stores. So this
  sends one byte first, which starts the firmware's read loop, then the rest
  in small pieces at half the line rate.
- It holds the port for the whole exchange and reads the board's replies from
  the same handle, so it can say whether the board stored the bundle and then
  whether it reached Wi-Fi and AWS IoT.

Secrets stay off the command line, where `ps` would show them to every user:
the bundle is read from its file and a Wi-Fi passphrase from the environment.
Nothing secret is printed: the firmware never echoes what it receives.

Standard library only, and Python 3.8 or later, so it runs on the python3 that
comes with the Xcode command line tools.
"""

import errno
import fcntl
import json
import os
import select
import struct
import sys
import termios
import time

# Exit codes. The shell scripts turn these into advice about the bundle file.
DONE = 0          # stored and confirmed: online, or the Wi-Fi network stored
NOT_STORED = 1    # nothing was stored: bad input, no port, or the board said no
HAS_IDENTITY = 2  # the board already has an identity, so nothing was sent
UNCONFIRMED = 3   # stored, but the board did not confirm it got online

# Tests run the same waits faster. Nothing else sets this.
SCALE = float(os.environ.get('BOARD_SERIAL_TIME_SCALE') or 1)

BYTES_PER_SECOND = 11520   # 115200 baud, 10 bits a byte
PIECE = 64                 # bytes per write: a fraction of the ESP32's buffer
MAX_BUNDLE = 6000          # a sanity bound: a real bundle is about 3 KB
NVS_LIMIT = 4000           # NVS refuses a string longer than this, NUL included,
                           # and the firmware would still print "identity stored"

# What the firmware prints (firmware/libraries/CloudAgenticDevice/src/CloudAgenticDevice.cpp).
ASKS_FOR_BUNDLE = 'PROVISIONING MODE'
ASKS_FOR_WIFI = 'WIFI RECOVERY MODE'
RUNNING = ('telemetry:', 'wifi:', 'aws:', 'OTA:', 'command:')
# Lines only a board with an identity prints: begin() stops before them without one.
WITH_IDENTITY = ('telemetry:', 'wifi: trying', 'wifi: connected', 'aws:')

# PubSubClient's connection states, as connectAWS() prints them.
MQTT_STATES = {
    '-4': 'AWS IoT did not answer in time',
    '-3': 'the connection dropped',
    '-2': 'the secure connection to the endpoint failed',
    '-1': 'the client disconnected',
    '1': 'AWS IoT refused the MQTT protocol version',
    '2': 'AWS IoT refused the client id',
    '3': 'AWS IoT was unavailable',
    '4': 'AWS IoT refused the credentials',
    '5': 'AWS IoT refused the connection: not authorized',
}

USAGE = ('usage: board_serial.py provision <port> <bundle.json>\n'
         '       board_serial.py wifi <port>   (WIFI_SSID and WIFI_PASS in the environment)')


class Stop(Exception):
    def __init__(self, code, message):
        Exception.__init__(self, message)
        self.code = code
        self.message = message


class KeptNothing(Stop):
    """The board said it stored the bundle, then came back without it."""


def say(text=''):
    print(text, flush=True)


def seconds(n):
    return n * SCALE


# ------------------------------------------------------------------ the port

def cannot_open(path, err):
    if err.errno == errno.EBUSY:
        return ('{} is busy: another program has it open. Close the serial monitor '
                '(Ctrl+C in its window) or the Arduino IDE, then run this again.'.format(path))
    if err.errno == errno.ENOENT:
        return 'There is no {}. Is the board plugged in?'.format(path)
    if err.errno == errno.EACCES:
        return ('No permission to open {}. On Linux, add yourself to the dialout group '
                '(sudo usermod -aG dialout "$USER") and log in again.'.format(path))
    return 'Could not open {}: {}.'.format(path, err.strerror)


def printable(raw):
    """The text of one line from the board, or '' for boot noise."""
    text = raw.decode('utf-8', 'replace').rstrip()
    if not text:
        return ''
    odd = sum(1 for c in text if c == '�' or (ord(c) < 32 and c != '\t'))
    if odd * 4 > len(text):
        return ''
    return ''.join(c for c in text if c != '�' and (ord(c) >= 32 or c == '\t')).strip()


class Board:
    def __init__(self, path):
        self.path = path
        self.pending = b''
        self.heard = False
        self.empty_reads = 0
        self.said = []
        try:
            self.fd = os.open(path, os.O_RDWR | os.O_NOCTTY | os.O_NONBLOCK)
        except OSError as err:
            raise Stop(NOT_STORED, cannot_open(path, err))
        try:
            # Keep everyone else off the port until we are done: a monitor
            # opened now would take half of the board's replies.
            fcntl.ioctl(self.fd, termios.TIOCEXCL)
        except (AttributeError, OSError):
            pass
        try:
            self._configure()
        except (termios.error, OSError) as err:
            os.close(self.fd)
            raise Stop(NOT_STORED, '{} is not a serial port this can use ({}).'.format(path, err))

    def _configure(self):
        # Raw bytes both ways at 115200: no echo, no line editing, no newline
        # translation, no flow control. Echo matters most: with it on, the
        # computer would send every line the board prints straight back to it.
        attrs = termios.tcgetattr(self.fd)
        cflag = attrs[2] & ~(termios.CSIZE | termios.PARENB | termios.CSTOPB
                             | getattr(termios, 'CRTSCTS', 0))
        cflag |= termios.CS8 | termios.CREAD | termios.CLOCAL
        cc = attrs[6]
        cc[termios.VMIN] = 0
        cc[termios.VTIME] = 0
        termios.tcsetattr(self.fd, termios.TCSANOW,
                          [0, 0, cflag, 0, termios.B115200, termios.B115200, cc])
        flags = fcntl.fcntl(self.fd, fcntl.F_GETFL)
        fcntl.fcntl(self.fd, fcntl.F_SETFL, flags & ~os.O_NONBLOCK)

    def close(self):
        try:
            os.close(self.fd)
        except OSError:
            pass

    def restart(self):
        """Restarts the board as esptool does, and returns whether it could.

        On the usual ESP32 auto-reset circuit, RTS asserted with DTR released
        holds EN low. Releasing RTS lets the board start, and because DTR is
        released too, GPIO0 stays high and the board runs its firmware rather
        than the bootloader. A port that cannot drive those lines (a board
        without the circuit, or a test's pseudo-terminal) gets a False.
        """
        held = False
        try:
            dtr = struct.pack('I', termios.TIOCM_DTR)
            rts = struct.pack('I', termios.TIOCM_RTS)
            fcntl.ioctl(self.fd, termios.TIOCMBIC, dtr)
            fcntl.ioctl(self.fd, termios.TIOCMBIS, rts)
            held = True
            time.sleep(0.1)
            # The board is held in reset now, so everything still waiting to
            # be read was printed before it: discard it with the old run.
            termios.tcflush(self.fd, termios.TCIFLUSH)
            self.pending = b''
            fcntl.ioctl(self.fd, termios.TIOCMBIC, rts)
            held = False
            return True
        except (AttributeError, OSError, termios.error):
            return False
        finally:
            if held:
                # Never leave the board held in reset: EN could not start it.
                try:
                    fcntl.ioctl(self.fd, termios.TIOCMBIC, rts)
                except OSError:
                    pass

    def lines(self, wait):
        """Yields each line the board prints during the next `wait` seconds,
        showing it as it goes. Boot noise is shown as nothing and yielded as ''."""
        deadline = time.monotonic() + seconds(wait)
        while True:
            while b'\n' in self.pending or len(self.pending) > 4096:
                raw, sep, rest = self.pending.partition(b'\n')
                self.pending = rest if sep else b''
                text = printable(raw)
                if text:
                    say('  | ' + text)
                    self.said = self.said[-200:] + [text]
                yield text
            left = deadline - time.monotonic()
            if left <= 0:
                return
            readable, _, _ = select.select([self.fd], [], [], min(left, 0.25))
            if not readable:
                continue
            try:
                chunk = os.read(self.fd, 4096)
            except OSError as err:
                if err.errno in (errno.EAGAIN, errno.EINTR):
                    continue
                raise Stop(NOT_STORED, 'Lost the connection to the board ({}). '
                                       'Is the USB cable still in?'.format(err.strerror))
            if chunk:
                self.heard = True
                self.empty_reads = 0
                self.pending += chunk
            else:
                # Readable but empty, again and again: on Linux that is a port
                # whose USB cable came out. It never errors, it just ends.
                self.empty_reads += 1
                if self.empty_reads >= 3:
                    raise Stop(NOT_STORED, 'Lost the connection to the board. Is the USB cable still in?')
                time.sleep(0.05)

    def send(self, data):
        """Writes `data` in small pieces at about half the line rate, so the
        board never has more than one piece waiting to be read."""
        try:
            for start in range(0, len(data), PIECE):
                piece = memoryview(data[start:start + PIECE])
                while piece:
                    piece = piece[os.write(self.fd, piece):]
                termios.tcdrain(self.fd)
                time.sleep(2.0 * PIECE / BYTES_PER_SECOND)
        except (OSError, termios.error) as err:
            raise Stop(NOT_STORED, 'Lost the connection to the board while sending ({}).'.format(err))


def where_it_is(line):
    """Which of its modes a line from the board shows, or None."""
    if ASKS_FOR_BUNDLE in line:
        return 'asks for bundle'
    if ASKS_FOR_WIFI in line:
        return 'asks for wifi'
    if line.startswith(RUNNING):
        return 'running'
    return None


# ---------------------------------------------------------------- the bundle

FIELDS = ('ssid', 'passphrase', 'thingName', 'endpoint', 'certificatePem', 'privateKey')


def read_bundle(path):
    """The one line the firmware reads, and the Thing it is for."""
    try:
        with open(path, encoding='utf-8') as f:
            bundle = json.load(f)
    except OSError as err:
        raise Stop(NOT_STORED, 'Could not read {}: {}.'.format(path, err.strerror))
    except ValueError:
        raise Stop(NOT_STORED, '{} is not a provisioning bundle: it is not JSON.'.format(path))
    if not isinstance(bundle, dict):
        raise Stop(NOT_STORED, '{} is not a provisioning bundle.'.format(path))

    missing = [k for k in FIELDS if k != 'passphrase'
               and not (isinstance(bundle.get(k), str) and bundle[k].strip())]
    if missing:
        raise Stop(NOT_STORED, '{} has no {}. Download the bundle again from the '
                               "device's Asset.".format(path, ', '.join(missing)))
    if not isinstance(bundle.get('passphrase', ''), str):
        raise Stop(NOT_STORED, "{}'s passphrase is not text.".format(path))
    for k in FIELDS:
        size = len((bundle.get(k) or '').encode('utf-8'))
        if size + 1 > NVS_LIMIT:
            raise Stop(NOT_STORED, "{}'s {} is {} bytes. The board stores at most {} in one value, "
                                   'and would keep nothing while saying it stored it.'.format(
                                       path, k, size, NVS_LIMIT - 1))
    cert, key = bundle['certificatePem'], bundle['privateKey']
    if '-----BEGIN CERTIFICATE-----' not in cert or '-----END CERTIFICATE-----' not in cert:
        raise Stop(NOT_STORED, "{}'s certificatePem is not a PEM certificate.".format(path))
    if '-----BEGIN' not in key or 'PRIVATE KEY-----' not in key or '-----END' not in key:
        raise Stop(NOT_STORED, "{}'s privateKey is not a PEM private key.".format(path))

    # Only the fields the firmware reads: anything else would only take room
    # in its 6 KB document.
    payload = dict((k, bundle.get(k) or '') for k in FIELDS)
    line = json.dumps(payload, separators=(',', ':'), ensure_ascii=False).encode('utf-8')
    if len(line) > MAX_BUNDLE:
        raise Stop(NOT_STORED, 'The bundle is {} bytes once compacted; the firmware takes at '
                               'most about {}.'.format(len(line), MAX_BUNDLE))
    return line, bundle['thingName']


# -------------------------------------------------------------- provisioning

def wait_until_asked(board):
    """Restarts the board, then reads until it says which mode it is in.
    Returns that mode and the line that showed it, or (None, None)."""
    if board.restart():
        say('Restarted the board. Waiting for it to ask for the bundle...')
    else:
        say('Waiting for the board to ask for the bundle...')
    for wait in (8, 60):
        for line in board.lines(wait):
            mode = where_it_is(line)
            if mode:
                return mode, line
        if wait == 8:
            say('Nothing yet. Press the EN button on the board (some boards label it RST; '
                'not BOOT) to restart it. Waiting a minute...')
    return None, None


def identity_on_board(board, first_line):
    """For a board that already has an identity, from what it prints next: the
    Thing it connects as (it says so only once on Wi-Fi), how far it gets
    ('online', 'refused', 'no wifi' or None), and the line that showed it."""
    thing, line = None, first_line
    lines = board.lines(30)
    while line is not None:
        if line.startswith('aws: connecting as '):
            thing = line[len('aws: connecting as '):].strip()
        elif line.startswith('aws: connected'):
            return thing, 'online', line
        elif line.startswith('aws: not connected'):
            return thing, 'refused', line
        elif ASKS_FOR_WIFI in line:
            return thing, 'no wifi', line
        line = next(lines, None)
    return thing, None, None


def explain_mqtt(line):
    state = line.rsplit(' ', 1)[-1]
    return MQTT_STATES.get(state, 'state ' + state)


def watch_it_connect(board, thing):
    """After a restart with an identity: waits for the board to reach AWS IoT."""
    for line in board.lines(90):
        if ASKS_FOR_BUNDLE in line:
            raise KeptNothing(NOT_STORED, 'The board said it stored the bundle, but it restarted '
                                          'without it and is asking again, so nothing usable was stored.')
        if line.startswith('aws: connected'):
            say()
            say('Online: {} is connected to AWS IoT.'.format(thing))
            return DONE
        if line.startswith('aws: not connected'):
            say()
            say('The board joined Wi-Fi, but AWS IoT did not accept it: {}. It keeps '
                'retrying on its own. If it never connects, check in AWS IoT that {} has '
                'an active certificate with the device policy attached.'.format(explain_mqtt(line), thing))
            return UNCONFIRMED
        if ASKS_FOR_WIFI in line:
            say()
            say("The board could not join any Wi-Fi network it knows, so it is asking for one. "
                'Within 2 minutes, or after pressing EN, run:')
            say('  ./scripts/update-wifi.sh "<SSID>" "<passphrase>"')
            return UNCONFIRMED
    say()
    say('The board did not say within 90 seconds whether it got online. Watch it with: '
        'scripts/firmware.sh monitor')
    return UNCONFIRMED


def provision(path, bundle_path):
    line, thing = read_bundle(bundle_path)
    say('Thing:  ' + thing)
    say('Port:   ' + path)
    board = Board(path)
    stored = False
    try:
        for attempt in (1, 2):
            mode, shown = wait_until_asked(board)
            if mode is None:
                raise Stop(NOT_STORED, 'The board never asked for a bundle, so nothing was sent. '
                                       'Check that it runs our firmware (scripts/firmware.sh flash '
                                       'patient-monitor) and that no serial monitor has the port.')
            if mode != 'asks for bundle':
                return already_has_identity(board, shown, thing)

            say('The board is asking for its bundle. Sending it...')
            board.send(b' ')          # starts the firmware's read loop...
            time.sleep(0.2)           # ...which then waits up to a second for each byte
            board.send(line + b'\n')

            reply = None
            for said in board.lines(15):
                if 'identity stored' in said:
                    reply = 'stored'
                elif 'not valid JSON' in said or said == 'timed out':
                    reply = said
                if reply:
                    break
            if reply == 'stored':
                stored = True
                break
            if attempt == 1:
                say('The board did not take it ({}). Trying once more.'.format(reply or 'no reply'))
        else:
            raise Stop(NOT_STORED, 'The board did not take the bundle twice ({}). Nothing was '
                                   'stored, so the bundle can be sent again.'.format(reply or 'no reply'))

        say('Stored. The board restarts and connects...')
        return watch_it_connect(board, thing)
    except KeptNothing:
        raise
    except Stop as stop:
        if stored:
            raise Stop(UNCONFIRMED, stop.message + ' The board had already stored the bundle.')
        raise
    except KeyboardInterrupt:
        say()
        say('Stopped.' + (' The board had already stored the bundle.' if stored else ' Nothing was stored.'))
        return UNCONFIRMED if stored else NOT_STORED
    finally:
        board.close()


def already_has_identity(board, shown, thing):
    on_board, outcome, line = identity_on_board(board, shown)
    say()
    if on_board == thing:
        if outcome == 'online':
            say('This board is already online as {}, so it does not need the bundle.'.format(thing))
            return DONE
        if outcome == 'refused':
            say('This board already holds an identity for {}, so nothing was sent, but AWS IoT does '
                'not accept it: {}. Check in AWS IoT that {} has an active certificate with the '
                'device policy attached. If it does, the copy on the board is likely damaged, for '
                'example by an earlier attempt that sent the bundle in one burst, and this bundle '
                'file is the intact copy: keep it.'.format(thing, explain_mqtt(line), thing))
        else:
            say('This board already holds an identity for {}, so nothing was sent. It did not get '
                'online while this watched.'.format(thing))
        return UNCONFIRMED
    if on_board:
        say('This board already has another identity, {}, so nothing was sent: it keeps the '
            'first identity it gets.'.format(on_board))
    else:
        say('This board already has an identity, so nothing was sent: it keeps the first '
            'identity it gets.')
    if outcome == 'no wifi':
        say('It cannot join any Wi-Fi network it knows. Within 2 minutes, or after pressing EN, '
            'run: ./scripts/update-wifi.sh "<SSID>" "<passphrase>"')
    return HAS_IDENTITY


# --------------------------------------------------------------------- Wi-Fi

def wifi_line(ssid, passphrase):
    if not ssid:
        raise Stop(NOT_STORED, 'No network name (WIFI_SSID) was given.')
    line = json.dumps({'ssid': ssid, 'passphrase': passphrase},
                      separators=(',', ':'), ensure_ascii=False).encode('utf-8')
    # An SSID is at most 32 bytes and a WPA passphrase 63 characters. The
    # firmware reads Wi-Fi lines into a 512-byte document.
    if len(line) > 240:
        raise Stop(NOT_STORED, 'That network name or passphrase is too long for Wi-Fi.')
    return line


def update_wifi(path, ssid, passphrase):
    line = wifi_line(ssid, passphrase)
    say('Port:   ' + path)
    board = Board(path)
    try:
        # No restart: a running board reads Wi-Fi details at any time. But
        # some computers restart it when they open the port, and a board that
        # is starting up cannot read yet, so look before sending.
        mode = None
        for said in board.lines(3):
            mode = where_it_is(said)
            if mode:
                break
        if not mode and board.heard:
            for said in board.lines(20):
                mode = where_it_is(said)
                if mode:
                    break
        if mode == 'asks for bundle':
            raise Stop(NOT_STORED, 'This board has no identity yet: it is asking for its '
                                     'provisioning bundle, not Wi-Fi details. Send the bundle '
                                     'with ./scripts/provision-device.sh <bundle.json>. Nothing was sent.')

        say('Sending the network...')
        board.send(line + b'\n')
        for said in board.lines(60):
            if 'wifi: updated over serial' in said:
                say()
                if any(line.startswith(WITH_IDENTITY) for line in board.said):
                    say('Stored. The board keeps its identity and certificate, and tries this '
                        'network whenever it needs to connect.')
                else:
                    say('Stored the network. The board printed nothing else, so it may have no '
                        'identity yet: ./scripts/provision-device.sh restarts it and says.')
                return DONE
            if 'identity left untouched' in said:
                say('Stored. The board restarts and connects...')
                return watch_it_connect(board, 'the board')
            if 'identity stored' in said:
                raise Stop(NOT_STORED, 'This board has no identity yet, so it stored only the '
                                         'network. Send its bundle with ./scripts/provision-device.sh '
                                         '<bundle.json>.')
            if said.startswith('wifi: ') and 'ignored' in said:
                raise Stop(NOT_STORED, 'The board did not take it ({}).'.format(said))
        raise Stop(UNCONFIRMED, 'The board did not confirm within a minute. Watch it with: '
                                'scripts/firmware.sh monitor')
    except KeyboardInterrupt:
        say()
        say('Stopped.')
        return NOT_STORED
    finally:
        board.close()


def main(argv):
    try:
        if len(argv) == 3 and argv[0] == 'provision':
            return provision(argv[1], argv[2])
        if len(argv) == 2 and argv[0] == 'wifi':
            return update_wifi(argv[1], os.environ.get('WIFI_SSID', ''), os.environ.get('WIFI_PASS', ''))
        say(USAGE)
        return NOT_STORED
    except Stop as stop:
        say()
        say(stop.message)
        return stop.code
    except KeyboardInterrupt:
        say()
        say('Stopped.')
        return NOT_STORED


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
