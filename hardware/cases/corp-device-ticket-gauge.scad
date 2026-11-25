// Corp (internal) device v2: desk "ticket gauge" with a bell
// ---------------------------------------------------------------------------
// What changed from v1:
//  - The body is now two parts that print without supports: a flat DIAL PLATE
//    (art facing up, so colours come from simple filament changes or paint)
//    and a TUB printed on its back. The plate clicks into the front of the tub.
//  - The SG90 is hidden: it screws (its own 2 screws) to posts inside the tub
//    and only its shaft comes through the plate. The needle sits 3 mm off the
//    dial and carries a round cap that hides the hole.
//  - The dial is tilted like a rev counter: the needle parks low on one side
//    ("CLEAR"), sweeps over the top, and ends high on the other side, where
//    its hammer hits the bell side-on (71% of its speed goes into the bell;
//    in v1 it only brushed past). The needle turns back there, so it never
//    has to push through the bell.
//  - The bell post ("mast") prints flat, has a shoulder, and plugs 24 mm deep
//    into a sleeve. A hanger rides on the mast's notched arm: slide it to set
//    how hard the hammer hits, and pick a hanger length for your bell.
//  - Board cradle, USB hole, coin pocket for ballast, front tray for stability.
// Art matches what the firmware does: with any open ticket the needle sweeps
// the whole dial and rings the bell at the end; more tickets = faster sweeps.
// So there are no levels: a green CLEAR mark where it parks, one red sweep arc
// with arrows toward the bell, and the legend "1 TICKET = SLOW, 5+ = FAST".
//
// Which way does your servo turn?  Most SG90s turn anticlockwise (seen from
// the shaft) as the firmware angle goes up: use bell_side = -1 (bell on the
// LEFT, CLEAR at the lower right). If yours turns clockwise, or the firmware
// is changed to reverse it, use bell_side = +1 (mirror image).
//
// Print (PLA, PETG or ABS; 0.2 mm; no supports), all as exported:
//   plate  - flat, art up       tub    - on its back      needle - flat
//   mast   - flat               hanger - flat             bell   - mouth down
// part = "plate" | "tub" | "needle" | "mast" | "hanger" | "bell" | "assembly"
part = "assembly";
bell_side = -1;          // -1 = bell on the left (default), +1 = on the right
dial = "speed";          // dial face: "speed" = CLEAR mark + one sweep arc + "1 TICKET = SLOW RING" (matches
                         // today's firmware); "levels" = the earlier face with 1..5+ and green/amber/red bands
                         // (only meaningful if the firmware is changed to hold the needle at the ticket count)
hanger_drop = 15;        // 5 for a bell about 43 mm tall incl. loop, 15 for about 33 (the printed bell), 25 for about 23
bell_r = 13;             // radius of the bell you hang (only used to draw the assembly)
fit = 0.3;
$fn = 96;
FONT = "Liberation Sans:style=Bold";

// ---------- main sizes ----------
R = 75;                  // dial radius
Hb = 66;                 // dial centre above the plate's bottom edge
top = 16;                // box top above the dial centre
pt = 3;                  // plate thickness
wall = 2.4;
Din = 52;                // inside depth of the tub behind the plate
lip = 1.4;               // tub rim in front of the plate
tray = 24;               // floor reaches this far in front of the plate
hw = R + 0.2;            // half width of the opening the plate sits in

// servo (SG90)
sg = [22.8, 12.4, 22.7]; sg_tab_under = 15.9; sg_shaft_off = 5.9; sg_hole = 2.4;
tab_plane = pt + 0.5 + (sg.z - sg_tab_under);   // y of the posts' front faces
// needle
needle_len = 62; hammer_r = 79.5; hammer_d = 7; cap_r = 15;
needle_back = -3.3;      // y of the needle's back face (art tops are at -1.2)
// sweep: t = 0 parked, t = 1 at the bell
a_start = bell_side < 0 ? 315 : 225;
function ang(t) = a_start - bell_side*180*t;
a_end = ang(1);
tip_end = (hammer_r + hammer_d/2) * [cos(a_end), sin(a_end)];
// mast and hanger
mast_x = bell_side*48; mast_y = [5.5, 11.5]; arm_z = [110, 120]; arm_x = [44, 98];
tenon = [8, 6]; sleeve_floor = top - wall - 24 + 2;
bar_z = [106, 109]; hook_y = -5.7;

// ---------- 2D helpers (front view: x right, y up, origin = dial centre) ----------
module plate_outline() {
  intersection() {
    union() { circle(r = R); translate([-R, -Hb]) square([2*R, Hb + top]); }
    translate([-R, -Hb]) square([2*R, Hb + R]);
  }
}
module arc_band(t0, t1, w0, w1, r_out) {      // band along the sweep, width w0 -> w1
  n = 40;
  polygon(concat(
    [for (i = [0 : n]) let (t = t0 + (t1 - t0)*i/n) r_out * [cos(ang(t)), sin(ang(t))]],
    [for (i = [n : -1 : 0]) let (t = t0 + (t1 - t0)*i/n, w = w0 + (w1 - w0)*i/n) (r_out - w) * [cos(ang(t)), sin(ang(t))]]));
}
module bell_icon() {
  hull() { translate([0, 3]) circle(d = 6); translate([-6, -4]) square([12, 1]); }
  translate([-7.5, -5.5]) square([15, 1.6]); translate([0, -7]) circle(d = 3.4);
  translate([0, 6.6]) circle(d = 2.6);
}

// ---------- dial plate (local z: 0 = back, pt = front face, art above) ----------
tier = [pt + 0.4, pt + 0.8, pt + 1.2];             // speed face: green, red, black tops
tierL = [pt + 0.4, pt + 0.8, pt + 1.2, pt + 1.6];  // levels face: green, amber, red, black tops
function bw(t) = 3 + 14*t;                      // levels face: band width along the sweep
t_lvl = [for (L = [1 : 5]) 0.06 + L*0.18];      // levels face: where 1..5+ sit
module servo_hole_2d() { hull() { circle(d = 13.6); translate([0, -7]) circle(d = 7.4); } }
module plate() {
  color("#f3f1ea") difference() {
    linear_extrude(pt) plate_outline();
    translate([0, 0, -1]) linear_extrude(pt + 2) servo_hole_2d();
  }
  if (dial == "levels") art_levels(); else art_speed();
}
module art_speed() {
  // art in three heights: change filament at each one, or paint the tops
  color("#2e9e5b") translate([0, 0, pt - 0.2]) linear_extrude(tier[0] - pt + 0.2) {
    rotate(ang(0)) translate([R - 15, -2]) square([12, 4]);          // where the needle parks
    translate(47 * [cos(ang(-0.13)), sin(ang(-0.13))]) offset(delta = 0.1)
      text("CLEAR", size = 7.5, halign = "center", valign = "center", font = FONT);
  }
  color("#e5483c") translate([0, 0, pt - 0.2]) linear_extrude(tier[1] - pt + 0.2) {
    arc_band(0.07, 0.97, 5, 5, R - 4);                               // the sweep
    d = -bell_side;                                                   // arrows point toward the bell
    for (t = [0.22, 0.42, 0.62, 0.82]) rotate(ang(t))
      polygon([[R - 19, -2.6*d], [R - 11, -2.6*d], [R - 15, 3.4*d]]);
  }
  color("#1d2733") translate([0, 0, pt - 0.2]) linear_extrude(tier[2] - pt + 0.2) {
    arc_band(-0.02, 1.02, 1.6, 1.6, R - 1.2);                         // rim line
    translate((R - 15) * [cos(ang(1.075)), sin(ang(1.075))]) bell_icon();
    // title and legend, lower quadrant on the bell side (the sweep never goes there)
    translate([bell_side*38.5, -20]) offset(delta = 0.15) text("HIGH TEMPERATURE", size = 4.8, halign = "center", font = FONT);
    translate([bell_side*38, -37]) text("TICKETS", size = 11.5, halign = "center", font = FONT);
    translate([bell_side*37, -47]) offset(delta = 0.15) text("1 TICKET = SLOW RING", size = 4, halign = "center", font = FONT);
    translate([bell_side*37, -55]) offset(delta = 0.15) text("5+ TICKETS = FAST RING", size = 4, halign = "center", font = FONT);
  }
}

module art_levels() {
  // coloured band in three steps (filament change at each height, or paint the tops)
  color("#3cb371") translate([0, 0, pt - 0.2]) linear_extrude(tierL[0] - pt + 0.2) arc_band(0.05, 0.40, bw(0.05), bw(0.40), R - 4);
  color("#f2b632") translate([0, 0, pt - 0.2]) linear_extrude(tierL[1] - pt + 0.2) arc_band(0.40, 0.70, bw(0.40), bw(0.70), R - 4);
  color("#e5483c") translate([0, 0, pt - 0.2]) linear_extrude(tierL[2] - pt + 0.2) arc_band(0.70, 0.99, bw(0.70), bw(0.99), R - 4);
  color("#1d2733") translate([0, 0, pt - 0.2]) linear_extrude(tierL[3] - pt + 0.2) {
    arc_band(-0.02, 1.02, 1.6, 1.6, R - 1.2);                       // rim line
    for (i = [0 : 4]) {                                             // level marks and numbers
      rotate(ang(t_lvl[i])) translate([R - 4 - bw(t_lvl[i]) - 1, -1.3]) square([bw(t_lvl[i]) + 1, 2.6]);
      translate((R - 32) * [cos(ang(t_lvl[i])), sin(ang(t_lvl[i]))])
        text(i == 4 ? "5+" : str(i + 1), size = 11, halign = "center", valign = "center", font = FONT);
    }
    translate(46 * [cos(ang(-0.115)), sin(ang(-0.115))]) text("CLEAR", size = 7, halign = "center", valign = "center", font = FONT);
    translate((R - 15) * [cos(ang(1.075)), sin(ang(1.075))]) bell_icon();
    translate([bell_side*38.5, -22]) offset(delta = 0.15) text("HIGH TEMPERATURE", size = 4.8, halign = "center", font = FONT);
    translate([bell_side*38, -41]) text("TICKETS", size = 11.5, halign = "center", font = FONT);
    translate([bell_side*38, -52]) offset(delta = 0.15) text("MORE TICKETS = HIGHER", size = 4, halign = "center", font = FONT);
  }
}

// ---------- tub (world: x right, z up from the dial centre, y = depth, plate front at y = 0) ----------
back_y = pt + Din;                 // inside face of the back wall
zf = -Hb - 0.2;                    // inside floor
module column(x0, x1, z0, z1, y0 = pt + 0.15) { translate([x0, y0, z0]) cube([x1 - x0, back_y - y0 + 0.1, z1 - z0]); }
module snap_bump(len) {            // sits just in front of the plate; 45 degree faces
  hull() { translate([0, -lip + 0.05, 0]) cube([0.01, lip - 0.1, len]); translate([-0.6, -0.9, 0]) cube([0.01, 0.35, len]); }
}
module tub() {
  bx = [17.5, 73]; bz = [-52.25, -23.75];                 // where the ESP32 lies (on the back wall)
  difference() {
    union() {
      // shell: back, sides, roof, floor (the floor runs forward as a tray)
      translate([-hw - wall, back_y, zf - wall]) cube([2*(hw + wall), wall, top - zf + wall]);
      for (s = [-1, 1]) translate([s > 0 ? hw : -hw - wall, -lip, zf - wall]) cube([wall, back_y + lip + 0.1, top - zf + wall]);
      translate([-hw - wall, pt + 0.15, top - wall]) cube([2*(hw + wall), back_y - pt, wall]);
      hull() {
        translate([-hw - wall, -lip, zf - wall]) cube([2*(hw + wall), back_y + lip + wall, wall]);
        for (s = [-1, 1]) translate([s*(hw + wall - 8), -tray + 8, zf - wall]) cylinder(r = 8, h = wall);
      }
      // servo posts (front faces at the tab plane) on a solid block behind the servo
      column(-5, 5,  sg_shaft_off + 0.3,  sg_shaft_off + sg_hole + 4, tab_plane);
      column(-5, 5, -(sg.x - sg_shaft_off) - sg_hole - 4, -(sg.x - sg_shaft_off) - 0.3, tab_plane);
      column(-5, 5, -(sg.x - sg_shaft_off) - sg_hole - 4, sg_shaft_off + sg_hole + 4, tab_plane + sg_tab_under + 1);
      // mast sleeves, both sides (use the one on the bell side)
      for (s = [-1, 1]) column(s*48 - 6.2, s*48 + 6.2, top - wall - 24, top - wall + 0.1);
      // plate seats in the lower corners + coin pocket (ballast) under the bell side
      column(bell_side > 0 ? -hw : hw - 6, bell_side > 0 ? -hw + 6 : hw, zf, zf + 6);
      column(bell_side*70 - 1, bell_side*70 + 1, zf, zf + 26);   // (outer wall is the tub side)
      column(bell_side*25 - 1, bell_side*25 + 1, zf, zf + 26);
      column(min(bell_side*25, bell_side*70), max(bell_side*25, bell_side*70), zf + 24, zf + 26);
      // ESP32 cradle on the back wall (side away from the bell): two ribs keep the
      // board 2 mm off the wall so a USB plug's moulding fits; posts round it, two with a catch
      mirror([bell_side > 0 ? 1 : 0, 0, 0]) {
        for (z = [-44, -32]) translate([bx[0] + 2, back_y - 2, z - 1]) cube([bx[1] - bx[0] - 12, 2.1, 2]);
        for (x = [bx[0] + 6, bx[1] - 10]) {
          translate([x, back_y - 11.5, bz[1] + fit]) cube([4, 11.6, 2.4]);
          translate([x, back_y - 11.5, bz[0] - fit - 2.4]) cube([4, 11.6, 2.4]);
          translate([x, back_y - 9.0, bz[1] + fit]) rotate([0, 90, 0]) linear_extrude(4) polygon([[0, -0.4], [0.7, 0.3], [0, 1.2]]);
        }
        translate([bx[0] - fit - 2.4, back_y - 11.5, -42]) cube([2.4, 11.6, 8]);
        // hook over the board's short edge (between the pin rows) so it cannot fall forward
        translate([bx[0] - fit, 0, -42]) linear_extrude(8) polygon([[0, back_y - 11.5], [3, back_y - 10], [0, back_y - 7]]);
      }
      // snap bumps that hold the plate in
      for (s = [-1, 1], z = [-45, -8]) translate([s*hw, 0, z]) mirror([s < 0 ? 1 : 0, 0, 0]) snap_bump(10);
      for (x = [-45, 35]) translate([x, 0, zf]) rotate([0, 90, 0]) snap_bump(10);
    }
    // slot through both posts, open on one side with a 45 degree roof: lower the servo in beside
    // the posts, slide it sideways onto them, and its cable drops into the slot
    translate([0, 0, -(sg.x - sg_shaft_off) - sg_hole - 5]) linear_extrude(sg.x + 2*sg_hole + 10) polygon([[-2.6, 27.21], [-2.6, 21], [5.1, 13.3], [5.1, 27.21]]);
    // servo screw pilots
    for (z = [sg_shaft_off + sg_hole, -(sg.x - sg_shaft_off) - sg_hole]) translate([0, tab_plane - 0.1, z]) rotate([-90, 0, 0]) cylinder(d = 1.7, h = 10);
    // mast sleeve holes (through the roof)
    for (s = [-1, 1]) translate([s*48 - tenon.x/2 - fit/2, mast_y[0] - fit/2, sleeve_floor]) cube([tenon.x + fit, tenon.y + fit + 0.3, 40]);
    // USB opening beside the board's socket
    mirror([bell_side > 0 ? 1 : 0, 0, 0]) translate([hw - 1, back_y - 9, -38 - 6.5]) cube([wall + 2, 10, 13]);
  }
}

// ---------- needle (local: +x = pointer, z 0 = back) ----------
module needle() {
  difference() {
    union() {
      cylinder(r = cap_r, h = 2.4);
      linear_extrude(2.4) polygon([[0, 5], [needle_len - 8, 2.2], [needle_len, 0], [needle_len - 8, -2.2], [0, -5]]);
      linear_extrude(2.4) translate([needle_len - 10, -1.6]) square([hammer_r - needle_len + 10, 3.2]);   // neck
      translate([hammer_r, 0, 0]) cylinder(d = hammer_d, h = 4.8);                                         // hammer
      linear_extrude(2.4) hull() { circle(d = 8); translate([-22, 0]) circle(d = 9); }                    // tail
    }
    translate([0, 0, -1]) cylinder(d = 2.6, h = 6);                                        // horn screw
    translate([0, 0, -0.01]) hull() { cylinder(d = 7.6, h = 1.5); translate([17.5, 0, 0]) cylinder(d = 4.8, h = 1.5); }
  }
}

// ---------- mast (2D in x/z, 6 thick) ----------
module mast_2d() {
  s = bell_side;
  // tenon, shoulder, post
  translate([mast_x - tenon.x/2, sleeve_floor + 0.3]) square([tenon.x, top - sleeve_floor]);
  translate([mast_x - 7, top]) square([14, 4]);
  translate([mast_x - 4, top]) square([8, arm_z[1] - top]);
  // arm with notches every 2 mm for the hanger
  difference() {
    translate([s > 0 ? arm_x[0] : -arm_x[1], arm_z[0]]) square([arm_x[1] - arm_x[0], arm_z[1] - arm_z[0]]);
    for (x = [arm_x[0] + 6 : 2 : arm_x[1] - 2]) translate([s*x, arm_z[1]]) rotate(45) square(1.2, center = true);
  }
  // gussets
  for (d = [-1, 1]) polygon([[mast_x + d*4, arm_z[0]], [mast_x + d*4, arm_z[0] - 14], [mast_x + d*18, arm_z[0]]]);
}
module mast() { linear_extrude(mast_y[1] - mast_y[0]) mast_2d(); }

// ---------- hanger (2D in y/z, 5 thick): saddle over the arm, reach forward, drop, hook ----------
hook_c = bar_z[0] - hanger_drop - 3;         // centre of the hook; the bell's loop rests 3 below
module hanger_2d(hook = false) {
  y0 = mast_y[0] - 0.1; y1 = mast_y[1] + 0.1;
  if (!hook) difference() {                                                        // saddle
    translate([y0 - 2.4, bar_z[0]]) square([y1 - y0 + 4.8, arm_z[1] + 2.6 - bar_z[0]]);
    translate([y0, bar_z[0] - 1]) square([y1 - y0, arm_z[1] - bar_z[0] + 1.05]);
  }
  if (!hook) translate([hook_y - 1.5, bar_z[0]]) square([y0 - hook_y + 1.5, bar_z[1] - bar_z[0]]);   // reach forward
  if (hook) translate([hook_y - 1.5, hook_c + 3.5]) square([3, bar_z[0] - hook_c - 3.4]);                 // drop
  if (hook) translate([hook_y, hook_c]) difference() {                                              // open hook
    circle(d = 11); circle(d = 6);
    rotate(145) translate([0, -2.25]) square([8, 4.5]);
  }
}
module hanger() {
  linear_extrude(5) hanger_2d();
  linear_extrude(3) hanger_2d(hook = true);   // thinner hook: takes a bell loop with a 4 mm hole or bigger
  // ridge that drops into the arm's notches
  translate([mast_y[0] - 0.1, arm_z[1] + 0.06, 2.5]) rotate([0, 90, 0]) rotate(180) linear_extrude(mast_y[1] - mast_y[0] + 0.2) polygon([[-0.8, 0], [0.8, 0], [0, 0.8]]);
}

// ---------- printed bell (fallback; a metal bell sounds far better) ----------
pb_h = 24; pb_r = 13; pb_wall = 1.6;
module pb_profile(off = 0) { polygon([[0, 0], [pb_r - off, 0], [pb_r - 1.5 - off, 4], [7.5 - off, pb_h - 5], [5 - off, pb_h - 1.5 - off], [0, pb_h - off]]); }
module printed_bell() {
  difference() { rotate_extrude() pb_profile(0); translate([0, 0, -0.01]) rotate_extrude() polygon([[0, 0], [11.4, 0], [9.9, 4], [6.8, 15.6], [0, 22.4]]); }
  translate([0, 0, pb_h + 4.2]) rotate([90, 0, 0]) difference() { cylinder(d = 12, h = 2.4, center = true); cylinder(d = 7, h = 4, center = true); }
  translate([-2.5, -1.2, pb_h - 1.6]) cube([5, 2.4, 2.4]);
}

// ---------- placement helpers ----------
module place_front() { translate([0, pt, 0]) rotate([90, 0, 0]) children(); }       // 2D-extruded parts: local z -> world -y
only = ""; t_show = 0.3; bell_tilt = 0;   // bell_tilt: swing angle for animation frames
module assembly(t = t_show) {
  if (only == "" || only == "plate") place_front() plate();
  if (only == "" || only == "tub") color("#dfe5ec") tub();
  if (only == "" || only == "servo") color("#2b2b2b") {
    translate([-sg.y/2, pt + 0.5, -(sg.x - sg_shaft_off)]) cube([sg.y, sg.z, sg.x]);
    translate([-sg.y/2, tab_plane - 2.5, -(sg.x - sg_shaft_off) - 4.8]) cube([sg.y, 2.5, 32.4]);
    translate([0, pt + 0.5, 0]) rotate([90, 0, 0]) cylinder(d = 11.8, h = 4);
    translate([0, pt + 0.5, -6.5]) rotate([90, 0, 0]) cylinder(d = 5.5, h = 4);
  }
  if (only == "" || only == "board") color("#3a7d44") mirror([bell_side > 0 ? 1 : 0, 0, 0]) translate([17.5, back_y - 2 - 3.1 - 1.6, -52.25]) cube([55.5, 1.6, 28.5]);
  if (only == "" || only == "needle") color("#e5483c") translate([0, needle_back, 0]) rotate([90, 0, 0]) rotate(ang(t)) needle();
  if (only == "" || only == "mast") color("#8f9aa6") translate([0, mast_y[1], 0]) rotate([90, 0, 0]) mast();
  bx = bell_side*(abs(tip_end[0]) - 1.5 + bell_r);
  if (only == "" || only == "hanger") color("#8f9aa6") translate([bx - 2.5, 0, 0]) rotate([90, 0, 90]) hanger();
  if (only == "" || only == "bell") color("#d4a017")
    translate([bx - 1, hook_y, hook_c]) rotate([0, bell_tilt, 0]) translate([0, 0, -3 + 0.34 - (pb_h + 7.7)]) printed_bell();
}

if (part == "plate") plate();
else if (part == "tub") translate([0, 0, back_y + wall]) rotate([-90, 0, 0]) tub();
else if (part == "needle") needle();
else if (part == "mast") mast();
else if (part == "hanger") hanger();
else if (part == "bell") printed_bell();
else if (part == "assembly") assembly();
