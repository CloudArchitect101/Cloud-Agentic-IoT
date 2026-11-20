#!/usr/bin/env node
/*
 * Draws the wiring diagrams for the two demo boards as SVG, so they look like
 * the real parts and every wire ends on the pin it plugs onto:
 *
 *   docs/images/wiring-monitored-device.svg  ESP32 + DHT11 (10 kΩ pull-up) + SG90
 *   docs/images/wiring-corp-gauge.svg        ESP32 + SG90 only
 *
 * The board is drawn as Vitaly holds the 38-pin 2A4RQ-ESP32 (DevKitC pin
 * order): the side with the printed pin names, USB at the bottom, 3.3V top
 * right. An inset shows the other side (metal shield), where the rows swap.
 *
 * Pins come from the firmware (DHT_PIN 4, SERVO_PIN 5);
 * test/config/wiring-diagrams.test.js checks that, and that the committed SVGs
 * are this script's output.
 *
 * Run: node scripts/draw-wiring.js        (writes both files)
 *      node scripts/draw-wiring.js --check (exit 1 if a file is out of date)
 */
'use strict';

const fs = require('fs');
const path = require('path');

// ---- The board's pin rows, as printed, top to bottom with USB at the bottom
// and the 3.3V row on the right (how the board is held in the diagrams).
const RIGHT_ROW = ['3.3V', 'EN', 'SVP', 'SVN', 'P34', 'P35', 'P32', 'P33', 'P25', 'P26',
  'P27', 'P14', 'P12', 'GND', 'P13', 'SD2', 'SD3', 'CMD', '5V'];
const LEFT_ROW = ['GND', 'P23', 'P22', 'TX', 'RX', 'P21', 'GND', 'P19', 'P18', 'P5',
  'P17', 'P16', 'P4', 'P0', 'P2', 'P15', 'SD1', 'SD0', 'CLK'];

// ---- What plugs where. `pin` is [row, index in that row].
const WIRES = {
  dhtVcc:   { from: 'DHT11 leg 1 (VCC)',  to: '3.3V', pin: ['R', 0],  color: '#d7262b', name: 'red' },
  dhtData:  { from: 'DHT11 leg 2 (DATA)', to: 'P4',   pin: ['L', 12], color: '#f2c318', name: 'yellow' },
  dhtGnd:   { from: 'DHT11 leg 4 (GND)',  to: 'GND',  pin: ['L', 6],  color: '#22252a', name: 'black' },
  servoSig: { from: 'Servo orange (signal)', to: 'P5', pin: ['L', 9], color: '#f07f13', name: 'orange' },
  servoVcc: { from: 'Servo red (+5 V)',   to: '5V',   pin: ['R', 18], color: '#d7262b', name: 'red' },
  servoGnd: { from: 'Servo brown (ground)', to: 'GND', pin: ['R', 13], color: '#7a4a24', name: 'brown' },
};

const FONT = "font-family=\"Helvetica, Arial, sans-serif\"";
const PITCH = 30.48; // 2.54 mm at 12 px/mm

// ---- Geometry (px, 12 px per mm for the board, sensor and servo)
const B = { x: 690, y: 210, w: 336, h: 660 };      // 28 x 55 mm board
const ROW_X = { L: B.x + 20, R: B.x + B.w - 20 };
const PIN_Y0 = B.y + 64;
const pinXY = ([row, i]) => [ROW_X[row], PIN_Y0 + i * PITCH];

// ---- helpers
const r1 = (n) => Math.round(n * 10) / 10;
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Smooth curve through points (Catmull-Rom as cubic Béziers).
function smooth(points) {
  let d = `M${r1(points[0][0])},${r1(points[0][1])}`;
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[i - 1] || points[i];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[i + 2] || p2;
    const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
    const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    d += ` C${r1(c1[0])},${r1(c1[1])} ${r1(c2[0])},${r1(c2[1])} ${r1(p2[0])},${r1(p2[1])}`;
  }
  return d;
}

// An insulated jumper wire: dark edge, colour, a highlight along it.
function wire(points, color, id) {
  const d = smooth(points);
  return `<g data-wire="${id}">` +
    `<path d="${d}" fill="none" stroke="#000" stroke-opacity=".55" stroke-width="10" stroke-linecap="round"/>` +
    `<path d="${d}" fill="none" stroke="${color}" stroke-width="7.5" stroke-linecap="round"/>` +
    `<path d="${d}" fill="none" stroke="#fff" stroke-opacity=".28" stroke-width="2" stroke-linecap="round" transform="translate(-1.2,-1.2)"/>` +
    `</g>`;
}

// A female jumper plug pushed onto a header pin, seen from above.
function plugOnPin(x, y, color, id) {
  return `<g data-plug="${id}">` +
    `<rect x="${r1(x - 14)}" y="${r1(y - 14)}" width="28" height="28" rx="3" fill="#15171a" stroke="#000"/>` +
    `<rect x="${r1(x - 9)}" y="${r1(y - 9)}" width="18" height="18" rx="2" fill="#2b2f35"/>` +
    `<rect x="${r1(x - 3)}" y="${r1(y - 3)}" width="6" height="6" fill="#c9ccd1"/>` +
    `<rect x="${r1(x - 14)}" y="${r1(y + 10)}" width="28" height="4" fill="${color}"/>` +
    `</g>`;
}

function label(x, y, text, opts = {}) {
  const size = opts.size || 15;
  const weight = opts.bold ? ' font-weight="700"' : '';
  const anchor = opts.anchor ? ` text-anchor="${opts.anchor}"` : '';
  const fill = opts.fill || '#1f2328';
  return `<text x="${r1(x)}" y="${r1(y)}" ${FONT} font-size="${size}"${weight}${anchor} fill="${fill}">${esc(text)}</text>`;
}

// The printed pin names, drawn after the wires so a wire never hides one.
function pinNames(used) {
  const out = ['<g id="pin-names">'];
  for (const [row, names] of [['L', LEFT_ROW], ['R', RIGHT_ROW]]) {
    names.forEach((name, i) => {
      const [px, py] = pinXY([row, i]);
      const u = used.find((v) => v.pin[0] === row && v.pin[1] === i);
      const lx = row === 'L' ? px + 24 : px - 24;
      const anchor = row === 'L' ? 'start' : 'end';
      if (u) {
        const tw = name.length * 9.5 + 12;
        const rx = row === 'L' ? lx - 5 : lx - tw + 5;
        out.push(`<rect x="${r1(rx)}" y="${r1(py - 11)}" width="${r1(tw)}" height="22" rx="4" fill="#fff" stroke="${u.color}" stroke-width="3"/>`);
        out.push(label(lx, py + 5.5, name, { size: 16, bold: true, anchor, fill: '#111' }));
      } else {
        out.push(label(lx, py + 5, name, { size: 14, anchor, fill: '#e2e4e7' }));
      }
    });
  }
  out.push('</g>');
  return out.join('');
}

// ---- The board, label side (pin tips through the PCB, names printed beside)
function board(used) {
  const out = [];
  const { x, y, w, h } = B;
  out.push(`<g id="esp32-board">`);
  out.push(`<rect x="${x + 4}" y="${y + 6}" width="${w}" height="${h}" rx="10" fill="#000" opacity=".18"/>`);
  out.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="10" fill="#17191d" stroke="#3a3f47" stroke-width="2"/>`);
  // silkscreen outline of the module on the other side, and the antenna end
  out.push(`<rect x="${x + 96}" y="${y + 14}" width="${w - 192}" height="${h * 0.5}" rx="4" fill="none" stroke="#e8e8e8" stroke-opacity=".35" stroke-dasharray="6 5"/>`);
  out.push(label(x + w / 2, y + 40, 'ANTENNA END', { size: 12, anchor: 'middle', fill: '#9aa0a8' }));
  out.push(label(x + w / 2, y + 150, 'ESP32', { size: 26, bold: true, anchor: 'middle', fill: '#e9e9e9' }));
  out.push(label(x + w / 2, y + 174, '38-pin · 2A4RQ-ESP32', { size: 13, anchor: 'middle', fill: '#b9bec5' }));
  out.push(label(x + w / 2, y + 194, 'side with the pin names', { size: 12, anchor: 'middle', fill: '#9aa0a8' }));
  for (const [row, names] of [['L', LEFT_ROW], ['R', RIGHT_ROW]]) {
    names.forEach((name, i) => {
      const [px, py] = pinXY([row, i]);
      out.push(`<circle cx="${r1(px)}" cy="${r1(py)}" r="10" fill="#c99a2e"/>`);
      out.push(`<circle cx="${r1(px)}" cy="${r1(py)}" r="6.5" fill="#7d5e14"/>`);
      out.push(`<rect x="${r1(px - 3.5)}" y="${r1(py - 3.5)}" width="7" height="7" fill="#d5d8dc"/>`);
    });
  }
  // micro-USB at the bottom end
  const ux = x + w / 2;
  out.push(`<rect x="${ux - 48}" y="${y + h - 30}" width="96" height="44" rx="5" fill="#b8bdc4" stroke="#7d838b" stroke-width="2"/>`);
  out.push(`<rect x="${ux - 34}" y="${y + h - 4}" width="68" height="12" rx="3" fill="#5b6068"/>`);
  out.push(`</g>`);
  return out.join('');
}

function usbCable() {
  const ux = B.x + B.w / 2;
  const y0 = B.y + B.h + 14;
  return `<g id="usb-cable">` +
    `<rect x="${ux - 30}" y="${y0}" width="60" height="58" rx="6" fill="#2d3036"/>` +
    `<path d="M${ux},${y0 + 58} C${ux},${y0 + 120} ${ux + 4},${y0 + 150} ${ux + 4},${y0 + 200}" fill="none" stroke="#2d3036" stroke-width="13" stroke-linecap="round"/>` +
    label(ux + 40, y0 + 120, 'USB cable to the computer', { size: 14, fill: '#444' }) +
    label(ux + 40, y0 + 138, 'or a power bank', { size: 14, fill: '#444' }) +
    `</g>`;
}

// ---- The bare 4-leg DHT11, grille facing you, legs down.
const D = { x: 150, y: 270, w: 144, h: 186 };
const legX = (n) => D.x + D.w / 2 + (n - 2.5) * PITCH;
const LEG_END = D.y + D.h + 210;
const DHT_PLUG = { top: LEG_END - 40, bottom: LEG_END + 66 };

function dht11() {
  const out = [`<g id="dht11">`];
  out.push(`<rect x="${D.x + 4}" y="${D.y + 6}" width="${D.w}" height="${D.h}" rx="8" fill="#000" opacity=".18"/>`);
  // legs (behind the body)
  for (let n = 1; n <= 4; n++) {
    const lx = legX(n);
    out.push(`<rect x="${r1(lx - 3)}" y="${D.y + D.h - 4}" width="6" height="${LEG_END - D.y - D.h + 4}" fill="#c7ccd3" stroke="#8b929b"/>`);
  }
  out.push(`<rect x="${D.x}" y="${D.y}" width="${D.w}" height="${D.h}" rx="8" fill="#3d9be0" stroke="#1f6fae" stroke-width="2"/>`);
  out.push(`<rect x="${D.x + 14}" y="${D.y + 12}" width="${D.w - 28}" height="${D.h - 44}" rx="5" fill="#2c84c8"/>`);
  for (let row = 0; row < 7; row++) {
    for (let col = 0; col < 5; col++) {
      out.push(`<rect x="${D.x + 22 + col * 20.5}" y="${D.y + 20 + row * 18.5}" width="13" height="11" rx="2" fill="#16466f"/>`);
    }
  }
  out.push(label(D.x + D.w / 2, D.y + D.h - 12, 'DHT11', { size: 15, bold: true, anchor: 'middle', fill: '#fff' }));
  // leg numbers just under the body
  for (let n = 1; n <= 4; n++) {
    out.push(`<circle cx="${r1(legX(n))}" cy="${D.y + D.h + 17}" r="10" fill="#fff" stroke="#1f6fae" stroke-width="1.5"/>`);
    out.push(label(legX(n), D.y + D.h + 22, String(n), { size: 13, bold: true, anchor: 'middle' }));
  }
  out.push(`</g>`);
  return out.join('');
}

// 10 kΩ resistor soldered across legs 1 and 2: brown, black, orange, gold.
function resistor() {
  const a = [legX(1), D.y + D.h + 44];
  const b = [legX(2), D.y + D.h + 168];
  const ang = Math.atan2(b[1] - a[1], b[0] - a[0]) * 180 / Math.PI;
  const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  const bodyL = 66;
  const bands = ['#7a4a24', '#111', '#f07f13', '#c9a227'];
  let g = `<g id="resistor-10k">`;
  g += `<line x1="${r1(a[0])}" y1="${r1(a[1])}" x2="${r1(b[0])}" y2="${r1(b[1])}" stroke="#9aa1aa" stroke-width="3"/>`;
  g += `<g transform="translate(${r1(mid[0])},${r1(mid[1])}) rotate(${r1(ang)})">`;
  g += `<rect x="${-bodyL / 2}" y="-11" width="${bodyL}" height="22" rx="10" fill="#e3c08f" stroke="#a8855a" stroke-width="1.5"/>`;
  [-21, -11, -1, 18].forEach((bx, i) => { g += `<rect x="${bx}" y="-11" width="6" height="22" fill="${bands[i]}"/>`; });
  g += `</g>`;
  for (const p of [a, b]) g += `<circle cx="${r1(p[0])}" cy="${r1(p[1])}" r="7" fill="#d9dde2" stroke="#8b929b" stroke-width="1.5"/>`;
  g += `</g>`;
  return { svg: g, a, b, len };
}

// A female jumper plug slid onto a sensor leg, seen from the side.
function plugOnLeg(n, color, id) {
  const lx = legX(n);
  const { top, bottom } = DHT_PLUG;
  return `<g data-plug="${id}">` +
    `<rect x="${r1(lx - 13)}" y="${top}" width="26" height="${bottom - top}" rx="3" fill="#15171a" stroke="#000"/>` +
    `<rect x="${r1(lx - 8)}" y="${top + 8}" width="16" height="${bottom - top - 22}" rx="2" fill="#2b2f35"/>` +
    `<rect x="${r1(lx - 13)}" y="${bottom - 8}" width="26" height="8" fill="${color}"/>` +
    `</g>`;
}

// ---- SG90 micro servo, seen from above, and its 3-pin plug.
function servo(S) {
  const out = [`<g id="sg90">`];
  out.push(`<rect x="${S.x + 4}" y="${S.y + 6}" width="${S.w}" height="${S.h}" rx="5" fill="#000" opacity=".18"/>`);
  // mounting ears
  out.push(`<rect x="${S.x - 54}" y="${S.y + S.h / 2 - 28}" width="${S.w + 108}" height="56" rx="6" fill="#2f63b8" stroke="#1b3f7c" stroke-width="2"/>`);
  for (const ex of [S.x - 34, S.x + S.w + 34]) out.push(`<circle cx="${ex}" cy="${S.y + S.h / 2}" r="9" fill="#f4f6f8" stroke="#1b3f7c" stroke-width="2"/>`);
  out.push(`<rect x="${S.x}" y="${S.y}" width="${S.w}" height="${S.h}" rx="6" fill="#3a74d0" fill-opacity=".92" stroke="#1b3f7c" stroke-width="2"/>`);
  // output shaft and horn near one end
  const sx = S.x + S.w - 52; const sy = S.y + S.h / 2;
  out.push(`<circle cx="${sx}" cy="${sy}" r="34" fill="#2f63b8" stroke="#1b3f7c" stroke-width="2"/>`);
  out.push(`<path d="M${sx - 12},${sy - 14} L${sx - 6},${sy - 108} a7,7 0 0 1 12,0 L${sx + 12},${sy - 14} Z" fill="#f4f6f8" stroke="#9aa1aa" stroke-width="1.5"/>`);
  out.push(`<circle cx="${sx}" cy="${sy}" r="17" fill="#f4f6f8" stroke="#9aa1aa" stroke-width="1.5"/>`);
  out.push(`<circle cx="${sx}" cy="${sy}" r="5" fill="#9aa1aa"/>`);
  for (let k = 1; k <= 4; k++) out.push(`<circle cx="${sx}" cy="${sy - 20 - k * 18}" r="2.6" fill="#9aa1aa"/>`);
  out.push(label(S.x + 64, sy + 6, 'SG90', { size: 22, bold: true, anchor: 'middle', fill: '#fff' }));
  out.push(label(S.x + 64, sy + 26, '9 g servo', { size: 12, anchor: 'middle', fill: '#dce6f5' }));
  out.push(`</g>`);
  return out.join('');
}

// Servo ribbon (brown, red, orange) from the servo's end to its 3-pin plug,
// which stands upright: ribbon in on the right, one male-to-female jumper per
// socket out on the left. Socket 0 brown, 1 red, 2 orange, top to bottom.
const socketY = (P, k) => P.y + 15 + k * PITCH;
function servoCable(S, P) {
  const colors = ['#7a4a24', '#d7262b', '#f07f13'];
  const out = [`<g id="servo-cable">`];
  colors.forEach((c, k) => {
    const off = (k - 1) * 8;
    const pts = [[S.x - 2, S.y + S.h / 2 + off], [S.x - 40, S.y + S.h / 2 + off + 30],
      [P.x + 90, socketY(P, k) - 10], [P.x + 30, socketY(P, k)]];
    out.push(`<path d="${smooth(pts)}" fill="none" stroke="#000" stroke-opacity=".45" stroke-width="8"/>`);
    out.push(`<path d="${smooth(pts)}" fill="none" stroke="${c}" stroke-width="6"/>`);
  });
  out.push(`<rect x="${P.x}" y="${P.y}" width="34" height="${r1(PITCH * 3)}" rx="3" fill="#15171a" stroke="#000"/>`);
  for (let k = 0; k < 3; k++) out.push(`<rect x="${P.x + 6}" y="${r1(socketY(P, k) - 9)}" width="18" height="18" rx="2" fill="#2b2f35"/>`);
  out.push(label(P.x + 60, P.y + PITCH * 3 + 30, 'servo plug', { size: 13, fill: '#444' }));
  out.push(`</g>`);
  return out.join('');
}

// The male end of a jumper pushed into socket k of the servo plug.
function maleInPlug(P, k, color) {
  const y = socketY(P, k);
  return `<g>` +
    `<rect x="${P.x - 50}" y="${r1(y - 12)}" width="52" height="24" rx="3" fill="#15171a" stroke="#000"/>` +
    `<rect x="${P.x - 50}" y="${r1(y - 12)}" width="8" height="24" fill="${color}"/>` +
    `</g>`;
}
const plugSocketOut = (P, k) => [P.x - 50, socketY(P, k)];

// The three servo jumpers. Orange crosses the lower, pin-free middle of the
// board to P5 on the other row.
function servoWires(P) {
  const s0 = plugSocketOut(P, 0); const s1 = plugSocketOut(P, 1); const s2 = plugSocketOut(P, 2);
  return [
    wire([s0, [s0[0] - 30, s0[1] - 6], pinXY(WIRES.servoGnd.pin)], WIRES.servoGnd.color, 'servoGnd'),
    wire([s1, [s1[0] - 26, s1[1] + 10], [1050, 800], pinXY(WIRES.servoVcc.pin)], WIRES.servoVcc.color, 'servoVcc'),
    wire([s2, [s2[0] - 20, s2[1] + 30], [1040, 905], [975, 895], [905, 775], [830, 600], pinXY(WIRES.servoSig.pin)],
      WIRES.servoSig.color, 'servoSig'),
  ];
}

function legend(x, y, rows, title) {
  const h = 54 + rows.length * 34;
  const out = [`<g id="legend">`];
  out.push(`<rect x="${x}" y="${y}" width="470" height="${h}" rx="10" fill="#fff" stroke="#d0d7de" stroke-width="1.5"/>`);
  out.push(label(x + 20, y + 32, title, { size: 18, bold: true }));
  rows.forEach((w, i) => {
    const yy = y + 66 + i * 34;
    out.push(`<rect x="${x + 20}" y="${yy - 14}" width="34" height="12" rx="6" fill="${w.color}" stroke="#000" stroke-opacity=".4"/>`);
    out.push(label(x + 66, yy - 3, `${w.from}`, { size: 15 }));
    out.push(label(x + 450, yy - 3, `→ ${w.to}`, { size: 16, bold: true, anchor: 'end' }));
  });
  out.push(`</g>`);
  return { svg: out.join(''), h };
}

// The other face of the board: metal shield, rows swapped.
function otherSide(x, y) {
  const w = 120; const h = 236;
  const out = [`<g id="other-side">`];
  out.push(`<rect x="${x - 20}" y="${y - 44}" width="${w + 330}" height="${h + 70}" rx="10" fill="#f6f8fa" stroke="#d0d7de" stroke-width="1.5"/>`);
  out.push(label(x, y - 16, 'The other side of the same board', { size: 16, bold: true }));
  out.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="5" fill="#17191d"/>`);
  out.push(`<rect x="${x + 22}" y="${y + 6}" width="${w - 44}" height="34" fill="#22252a" stroke="#555"/>`);
  out.push(`<path d="M${x + 30},${y + 30} h8 v-16 h8 v16 h8 v-16 h8 v16 h8 v-16 h8 v16 h8" fill="none" stroke="#c99a2e" stroke-width="2"/>`);
  out.push(`<rect x="${x + 22}" y="${y + 40}" width="${w - 44}" height="82" rx="2" fill="#c3c8cf" stroke="#8b929b"/>`);
  out.push(label(x + w / 2, y + 86, 'ESP-WROOM-32', { size: 8.5, bold: true, anchor: 'middle', fill: '#555' }));
  for (let i = 0; i < 19; i++) {
    out.push(`<circle cx="${x + 9}" cy="${r1(y + 20 + i * 11)}" r="3" fill="#c99a2e"/>`);
    out.push(`<circle cx="${x + w - 9}" cy="${r1(y + 20 + i * 11)}" r="3" fill="#c99a2e"/>`);
  }
  out.push(`<rect x="${x + 28}" y="${y + h - 40}" width="14" height="10" fill="#eee"/><rect x="${x + w - 42}" y="${y + h - 40}" width="14" height="10" fill="#eee"/>`);
  out.push(`<rect x="${x + w / 2 - 16}" y="${y + h - 14}" width="32" height="18" rx="3" fill="#b8bdc4"/>`);
  out.push(`<circle cx="${x + 9}" cy="${y + 20}" r="6" fill="none" stroke="#d7262b" stroke-width="2.5"/>`);
  out.push(`<circle cx="${x + 9}" cy="${r1(y + 20 + 18 * 11)}" r="6" fill="none" stroke="#d7262b" stroke-width="2.5"/>`);
  out.push(label(x + w + 18, y + 26, '← 3.3V is now top LEFT', { size: 14, bold: true, fill: '#b42318' }));
  out.push(label(x + w + 18, y + 20 + 18 * 11 + 5, '← 5V bottom left', { size: 14, bold: true, fill: '#b42318' }));
  out.push(label(x + w + 18, y + 86, 'Metal shield up: the two', { size: 14 }));
  out.push(label(x + w + 18, y + 106, 'pin rows swap sides.', { size: 14 }));
  out.push(label(x + w + 18, y + 136, 'Go by the printed names,', { size: 14 }));
  out.push(label(x + w + 18, y + 156, 'not by left or right.', { size: 14 }));
  out.push(`</g>`);
  return out.join('');
}

// The docs' platform icons (docs/images/platforms), inlined so the SVG stands alone.
function icon(name, x) {
  const src = fs.readFileSync(path.join(__dirname, '..', 'docs', 'images', 'platforms', `${name}.svg`), 'utf8');
  const inner = src.replace(/^[\s\S]*?<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '').replace(/<title>[\s\S]*?<\/title>/, '');
  const vb = (src.match(/viewBox="([^"]+)"/) || [, '0 0 24 24'])[1];
  return `<svg x="${x}" y="26" width="36" height="36" viewBox="${vb}">${inner}</svg>`;
}

function header(title, subtitle) {
  return `<g id="title">` + icon('esp32', 40) + icon('electronics', 82) +
    label(132, 56, title, { size: 28, bold: true }) +
    label(40, 98, subtitle, { size: 16, fill: '#57606a' }) +
    `</g>`;
}

function svgDoc(w, h, body, desc) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img" aria-labelledby="t d">` +
    `<title id="t">${esc(desc.title)}</title><desc id="d">${esc(desc.text)}</desc>` +
    `<rect width="${w}" height="${h}" fill="#ffffff"/>` + body + `</svg>\n`;
}

// Wire from a board pin, leaving its plug toward `dir` first.
function fromPin(pin, ...rest) {
  const [x, y] = pinXY(pin);
  return [[x, y], ...rest];
}

// ---------------------------------------------------------------- diagrams
const SERVO = { x: 1290, y: 600, w: 270, h: 146 };
const SERVO_PLUG = { x: 1120, y: 690 };

function servoParts(parts) {
  const S = SERVO; const P = SERVO_PLUG;
  parts.push(servo(S));
  parts.push(servoCable(S, P));
  parts.push(label(S.x + S.w / 2, S.y + S.h + 50, 'Servo wires: brown = ground, red = +5 V, orange = signal', { size: 14, anchor: 'middle', fill: '#57606a' }));
  parts.push(label(P.x - 40, P.y + PITCH * 3 + 70, '3 male-to-female jumpers', { size: 13, fill: '#57606a' }));
  parts.push(label(P.x - 40, P.y + PITCH * 3 + 88, 'from the servo plug to the board', { size: 13, fill: '#57606a' }));
}

function servoPlugEnds(parts) {
  for (const [k, w] of [[0, WIRES.servoGnd], [1, WIRES.servoVcc], [2, WIRES.servoSig]]) parts.push(maleInPlug(SERVO_PLUG, k, w.color));
}

function monitoredDevice() {
  const W = 1720; const H = 1290;
  const used = [WIRES.dhtVcc, WIRES.dhtData, WIRES.dhtGnd, WIRES.servoSig, WIRES.servoVcc, WIRES.servoGnd];
  const parts = [];
  parts.push(header('Monitored device: wiring',
    'ESP32 (38-pin) + DHT11 temperature sensor with a 10 kΩ resistor + SG90 servo. Six jumper wires, one plug per pin.'));
  parts.push(board(used));
  parts.push(usbCable());
  parts.push(dht11());
  const res = resistor();
  parts.push(res.svg);
  servoParts(parts);

  const plugBottom = (n) => [legX(n), DHT_PLUG.bottom];
  const wires = [];
  // red: leg 1 round the left and over the top, down onto 3.3V
  wires.push(wire([plugBottom(1), [legX(1) - 10, DHT_PLUG.bottom + 70], [80, 820], [70, 420], [140, 175],
    [560, 150], [960, 150], [1060, 190], pinXY(WIRES.dhtVcc.pin)], WIRES.dhtVcc.color, 'dhtVcc'));
  // yellow: leg 2 down, then right and up onto P4
  wires.push(wire([plugBottom(2), [legX(2) + 10, DHT_PLUG.bottom + 80], [470, 840], [600, 700], pinXY(WIRES.dhtData.pin)],
    WIRES.dhtData.color, 'dhtData'));
  // black: leg 4 down, then right and up onto GND (left row)
  wires.push(wire([plugBottom(4), [legX(4) + 30, DHT_PLUG.bottom + 40], [450, 690], [560, 470], pinXY(WIRES.dhtGnd.pin)],
    WIRES.dhtGnd.color, 'dhtGnd'));
  wires.push(...servoWires(SERVO_PLUG));

  parts.push(plugOnLeg(1, WIRES.dhtVcc.color, 'dhtVcc'));
  parts.push(plugOnLeg(2, WIRES.dhtData.color, 'dhtData'));
  parts.push(plugOnLeg(4, WIRES.dhtGnd.color, 'dhtGnd'));
  servoPlugEnds(parts);
  parts.push(wires.join(''));
  for (const [id, w] of Object.entries(WIRES)) {
    const [x, y] = pinXY(w.pin);
    parts.push(plugOnPin(x, y, w.color, id));
  }
  parts.push(pinNames(used));

  // callouts
  parts.push(label(D.x - 10, D.y - 40, 'DHT11, grille facing you, legs down', { size: 15, bold: true }));
  parts.push(label(D.x - 10, D.y - 20, '1 VCC · 2 DATA · 3 not used · 4 GND', { size: 14, fill: '#57606a' }));
  parts.push(label(legX(4) + 26, res.a[1] + 30, '10 kΩ resistor', { size: 15, bold: true }));
  parts.push(label(legX(4) + 26, res.a[1] + 48, 'soldered across legs 1 and 2', { size: 13, fill: '#57606a' }));
  parts.push(label(legX(4) + 26, res.a[1] + 66, 'bands: brown black orange gold', { size: 13, fill: '#57606a' }));
  parts.push(label(legX(4) + 26, DHT_PLUG.top + 30, '3 female jumpers', { size: 13, fill: '#57606a' }));
  parts.push(label(legX(4) + 26, DHT_PLUG.top + 48, 'on legs 1, 2 and 4', { size: 13, fill: '#57606a' }));

  parts.push(legend(1210, 140, used, 'Connect').svg);
  parts.push(otherSide(150, 1020));

  return svgDoc(W, H, parts.join('\n'), {
    title: 'Monitored device wiring: ESP32, DHT11 with 10 kΩ pull-up, SG90 servo',
    text: 'Board held with the printed pin names facing you, USB at the bottom, 3.3V top right. ' +
      used.map((w) => `${w.from} to ${w.to} with a ${w.name} jumper`).join('; ') +
      '. The 10 kΩ resistor is soldered across DHT11 legs 1 and 2; leg 3 is not used.',
  });
}

function corpGauge() {
  const W = 1720; const H = 1110;
  const used = [WIRES.servoSig, WIRES.servoVcc, WIRES.servoGnd];
  const parts = [];
  parts.push(header('Corp ticket gauge: wiring',
    'ESP32 (38-pin) + SG90 servo only. No sensor, and no wire goes to the bell: the needle on the servo rings it.'));
  parts.push(board(used));
  parts.push(usbCable());
  servoParts(parts);
  servoPlugEnds(parts);
  parts.push(servoWires(SERVO_PLUG).join(''));
  for (const id of ['servoSig', 'servoVcc', 'servoGnd']) {
    const [x, y] = pinXY(WIRES[id].pin);
    parts.push(plugOnPin(x, y, WIRES[id].color, id));
  }
  parts.push(pinNames(used));
  parts.push(legend(1210, 140, used, 'Connect').svg);
  parts.push(otherSide(110, 300));
  parts.push(label(90, 660, 'The servo sits in the gauge\'s tub. The needle', { size: 15 }));
  parts.push(label(90, 682, 'screws onto its horn and taps the bell at the', { size: 15 }));
  parts.push(label(90, 704, 'end of each sweep. More open tickets, faster', { size: 15 }));
  parts.push(label(90, 726, 'sweeps, so the bell rings faster.', { size: 15 }));
  return svgDoc(W, H, parts.join('\n'), {
    title: 'Corp ticket gauge wiring: ESP32 and SG90 servo',
    text: 'Board held with the printed pin names facing you, USB at the bottom, 3.3V top right. ' +
      used.map((w) => `${w.from} to ${w.to} with a ${w.name} jumper`).join('; ') + '. No wire goes to the bell.',
  });
}

const OUTPUTS = {
  'docs/images/wiring-monitored-device.svg': monitoredDevice,
  'docs/images/wiring-corp-gauge.svg': corpGauge,
};

module.exports = { WIRES, LEFT_ROW, RIGHT_ROW, OUTPUTS, monitoredDevice, corpGauge };

if (require.main === module) {
  const root = path.resolve(__dirname, '..');
  const check = process.argv.includes('--check');
  let stale = 0;
  for (const [rel, fn] of Object.entries(OUTPUTS)) {
    const file = path.join(root, rel);
    const svg = fn();
    if (check) {
      const cur = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
      if (cur !== svg) { console.error(`out of date: ${rel}`); stale++; }
    } else {
      fs.writeFileSync(file, svg);
      console.log(`wrote ${rel}`);
    }
  }
  process.exit(stale ? 1 : 0);
}
