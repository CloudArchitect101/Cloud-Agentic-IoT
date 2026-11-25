// Monitored device v2: one rigid arm cuff (generic "temperature alert" device)
// ---------------------------------------------------------------------------
// What changed from v1: the two flexible TPU straps and the loose sensor pod
// are gone. One springy C-shaped cuff clips round the upper arm. The DHT11
// sits in the cuff's inner side (the side of the arm that rests against the
// body, under the arm); the hub with the ESP32 and the SG90 slides onto a
// rail on the outer side. Every part prints in rigid plastic (PLA, PETG or
// ABS), no supports:
//   cuff      - print standing on its edge (as exported)
//   hub       - print floor down (as exported)
//   hub_lid   - print top face down (as exported)
//   sensor_lid- print flat, plug up (as exported)
//   wiper     - print with the "!" tile on the bed (as exported)
// Not printed: ESP32, DHT11 + 10k resistor, SG90 with its horn and screws,
// 3 jumper wires (about 20 cm), USB cable.
//
// part = "cuff" | "hub" | "hub_lid" | "sensor_lid" | "wiper" | "assembly"
part = "assembly";
// Arm size: inner radius of the cuff. 40 = arm 24-27 cm round, 46 = 27-31 cm,
// 52 = 31-35 cm (measure round the upper arm, relaxed).
Rc = 46;
fit = 0.3;            // clearance for sliding/pressed fits (0.3 PLA, 0.4 ABS)
$fn = 72;
FONT = "Liberation Sans:style=Bold";

// ---------- real hardware (mm) ----------
dht  = [15.5, 12.2, 5.6];     // DHT11 body; legs leave one 12.2 x 5.6 end
esp  = [55.5, 28.5];          // 38-pin ESP32 board outline
sg   = [22.8, 12.4, 22.7];    // SG90 body: length, thickness, height of case
sg_tabs = 32.4;               // across the mounting tabs
sg_tab_top = 18.4;            // case bottom to the top face of the tabs
sg_shaft_off = 5.9;           // shaft centre to the near end of the body

// ---------- cuff ----------
band_t = 2.6; band_w = 30; cover = 250;      // thickness, width, degrees covered
pad_h  = 64;                  // height of the hub pad and rail (along the arm)
pad_half = 20; pad_out = Rc + 6;             // flat pad: half width, outer plane
rail_h = 3; rail_top = 14; rail_root = 10.5; // dovetail rail the hub slides on
skin = 0.8; lid_t = 1.6;
boss_out = skin + dht.z + 0.2 + lid_t;       // sensor boss outer plane beyond Rc
boss_u = [-11, 30.5];           // boss extent along the band (0 = sensor centre)
bay_u  = 27;                  // wiring bay ends here
pocket_z0 = 6;                // sensor sits from here up; pocket is open at the top edge
gut_z = 13;                   // floor of the wire gutter
det_y = 12; det_z = 5;        // click bumps that stop the hub sliding back off the rail

module sector(r, a0, a1) {
  polygon(concat([[0, 0]], [for (a = [a0 : 2 : a1]) [r*cos(a), r*sin(a)]], [[r*cos(a1), r*sin(a1)]]));
}
a0 = -(cover - 180)/2; a1 = 180 - a0;

module band_2d() {
  intersection() {
    difference() { circle(r = Rc + band_t); circle(r = Rc); }
    sector(Rc + band_t + 5, a0, a1);
  }
  for (a = [a0, a1]) rotate(a) translate([Rc + band_t/2 + 0.8, 0]) circle(d = band_t + 1.8);  // soft flared tips
}
module pad_2d() {
  difference() {
    translate([0, -pad_half]) square([pad_out, 2*pad_half]); circle(r = Rc);
    // relief slot behind each click bump: leaves a 0.8 mm skin that can spring in
    for (s = [-1, 1]) translate([pad_out - 1.8, s*det_y - 6]) square([1.0, 12]);
  }
  polygon([[pad_out - 0.01, -rail_root/2], [pad_out + rail_h, -rail_top/2],
           [pad_out + rail_h,  rail_top/2], [pad_out - 0.01,  rail_root/2]]);
}
module boss_2d() {
  difference() {
    hull() {
      translate([-(Rc + boss_out) + 2, boss_u[0] + 2]) circle(r = 2);
      translate([-(Rc + boss_out) + 2, boss_u[1] - 2]) circle(r = 2);
      translate([-Rc + 12, boss_u[0]]) square([0.1, boss_u[1] - boss_u[0]]);
    }
    circle(r = Rc);
  }
}
// boss frame: bx(d) = world x for a depth d beyond the skin plane, u = world y
function bx(d) = -(Rc + d);

module cuff() {
  difference() {
    union() {
      linear_extrude(band_w) band_2d();
      linear_extrude(pad_h) pad_2d();
      linear_extrude(band_w) boss_2d();
      // wire gutter on the outside of the band, from the sensor boss to the hub pad:
      // a shelf with a 45 degree underside and an upright lip, open towards the top edge
      rotate(asin(pad_half/(Rc + band_t)) + 1)
        rotate_extrude(angle = (180 - atan(boss_u[1]/Rc)) - (asin(pad_half/(Rc + band_t)) + 1) + 1)
          polygon([[Rc + band_t - 0.2, gut_z - 4.8], [Rc + band_t + 4.6, gut_z - 0.2],
                   [Rc + band_t + 4.6, gut_z + 3.2], [Rc + band_t + 3.4, gut_z + 3.2],
                   [Rc + band_t + 3.4, gut_z], [Rc + band_t - 0.2, gut_z]]);
    }
    // --- sensor pocket + wiring bay, open at the top edge (no bridges) ---
    translate([bx(skin + dht.z + 0.2), -dht.x/2 - fit, pocket_z0])
      cube([dht.z + 0.2, bay_u + dht.x/2 + fit, band_w]);
    // window to the skin: three slots, two upright bars keep fingers out
    for (i = [-1, 0, 1]) translate([-(Rc + skin + 0.1), i*4.4 - 1.6, pocket_z0 + 1.4])
      cube([Rc*0.2, 3.2, dht.y - 2.6]);
    // dovetail slot for the sliding lid (wider at the bottom, so the lid cannot lift out)
    translate([0, 0, pocket_z0 - 2]) linear_extrude(band_w)
      polygon([[bx(skin + dht.z + 0.2), -dht.x/2 - fit - 1.6], [bx(boss_out) - 0.1, -dht.x/2 - fit],
               [bx(boss_out) - 0.1, bay_u], [bx(skin + dht.z + 0.2), bay_u + 1.6]]);
    // wire exit from the bay into the gutter
    hull() {
      translate([bx(skin + dht.z - 0.6), bay_u - 1, gut_z]) cube([4.6, 1, band_w]);
      rotate(180 - atan(boss_u[1]/Rc) - 5) translate([Rc + band_t, -0.5, gut_z]) cube([3.4, 1, band_w]);
    }
    // optional: slots near the two tips for a strap or elastic, if you ever want one
    for (a = [a0 + 4.5, a1 - 4.5]) rotate(a) translate([Rc - 2, -1.5, 4]) cube([band_t + 4, 3, band_w - 8]);
  }
  // click bumps beside the rail: they drop into two dimples under the hub
  for (y = [-det_y, det_y]) translate([pad_out, y, det_z]) scale([0.8/1.6, 1, 1]) sphere(r = 1.6, $fn = 24);
}

// Sliding lid for the sensor: plate with dovetail edges and a plug that fills
// the pocket above the DHT11 so it cannot move. Slide in from the top edge.
lid_len = band_w - pocket_z0 + 2;
module sensor_lid() {
  w0 = bay_u + dht.x/2 + fit;                     // opening width
  // plate (dovetail: wide face down on the bed)
  hull() {
    translate([-1.6 + fit, 0, 0]) cube([w0 + 3.2 - 2*fit, lid_len, 0.01]);
    translate([fit, 0, lid_t - 0.01]) cube([w0 - 2*fit, lid_len, 0.01]);
  }
  // plug above the sensor (sensor end of the plate), stops 0.2 short of the skin floor
  translate([w0 - dht.x - 0.3, 2 + dht.y + 0.4, -(dht.z)]) cube([dht.x, lid_len - (2 + dht.y + 0.4), dht.z]);
  // friction bump so the lid does not slide back out on its own
  translate([w0 - 0.3, lid_len - 4, -dht.z/2]) scale([0.45, 1, 1]) sphere(r = 1, $fn = 24);
}
module sensor_lid_print() { translate([0, 0, lid_t]) rotate([180, 0, 0]) translate([0, -lid_len, 0]) sensor_lid(); }

// ---------- hub ----------
wall = 2.2; floor_t = 5;
hin = [82, 34, 28];                         // inside: length, width, height
hub = [hin.x + 2*wall, hin.y + 2*wall, hin.z + floor_t];
board_x = 0.5;                              // board starts here (inside), USB at this end
div_x = board_x + esp.x + 0.3;              // divider behind the board
ped_h = hin.z - 0.3 - sg.y;                 // servo rests on ribs this high
shaft_y = hin.y/2 + (sg.x/2 - sg_shaft_off);// shaft position across the hub (inside)
shaft_z = ped_h + sg.y/2;                   // and above the inside floor
groove_len = pad_h + 0.4;

module rbox(s, r = 4) { hull() for (x = [r, s.x - r], y = [r, s.y - r]) translate([x, y, 0]) cylinder(r = r, h = s.z); }

module hub_body() {
  difference() {
    rbox(hub);
    translate([wall, wall, floor_t]) cube([hin.x, hin.y, hin.z + 1]);
    // dovetail groove under the floor, open at the servo end
    translate([hub.x - groove_len, hub.y/2, -0.01]) rotate([90, 0, 90]) linear_extrude(groove_len + 1)
      polygon([[-(rail_root/2 + fit), 0], [-(rail_top/2 + fit + fit*(rail_top - rail_root)/(2*rail_h)), rail_h + fit + 0.4],
               [(rail_top/2 + fit + fit*(rail_top - rail_root)/(2*rail_h)), rail_h + fit + 0.4], [(rail_root/2 + fit), 0]]);
    // USB opening (board lies component side down, socket under the board)
    translate([-1, hub.y/2 - 6.5, floor_t - 3.4]) cube([wall + 2, 13, 10]);
    // notch for the servo's output boss in the end wall, open to the rim
    translate([hub.x - wall - 1, wall + shaft_y - 9.8, floor_t + ped_h - 0.3]) cube([wall + 2, 16.4, hin.z]);
    // sensor wires come in here, low on the long wall under the raised servo
    translate([wall + 66, hub.y - wall - 1, floor_t]) cube([6, wall + 2, 6]);
    // dimples for the cuff's click bumps
    for (y = [-det_y, det_y]) translate([hub.x - det_z, hub.y/2 + y, 0]) scale([1, 1, 0.9/1.9]) sphere(r = 1.9, $fn = 24);
    // windows for the lid's snap bumps
    for (x = [15, 45], y = [-1, hub.y - wall - 1]) translate([wall + x - 4.5, y, floor_t + hin.z - 5.2]) cube([9, wall + 2, 3.0]);
  }
  translate([wall, wall, floor_t]) {
    // board guides (the board rests on its own metal can and USB socket, pins up)
    for (x = [12, 44], y = [0, hin.y - (hin.y - esp.y)/2 + fit]) translate([x, y, 0]) cube([2, (hin.y - esp.y)/2 - fit, 9]);
    translate([div_x, 0, 0]) cube([2, hin.y, 8]);                       // divider / end stop
    // servo pedestal ribs and the ribs behind its mounting tabs
    for (y = [hin.y/2 - 7 - 1.2, hin.y/2 + 7 - 1.2]) translate([div_x + 2.5, y, 0]) cube([hin.x - div_x - 4.5, 2.4, ped_h]);
    for (y = [0, hin.y - 5]) translate([hin.x - (sg.z - sg_tab_top) - 2.5 - fit - 2, y, 0]) cube([2, 5, hin.z]);
    for (y = [0, hin.y - 4.6]) translate([hin.x - (sg.z - sg_tab_top) + fit, y, 0]) cube([sg.z - sg_tab_top - fit + 0.1, 4.6, hin.z]);
  }
}

module hub_lid() {
  difference() {
    union() {
      rbox([hub.x, hub.y, 2.4]);
      // lip round the board bay only (the servo tabs fill the other end)
      translate([wall + fit, wall + fit, -5]) difference() {
        cube([div_x - 2, hin.y - 2*fit, 5]);
        translate([1.6, 1.6, -1]) cube([div_x, hin.y - 2*fit - 3.2, 7]);
      }
      // snap bumps: 45 degree faces, they click into the hub's windows
      for (x = [15, 45], s = [0, 1]) translate([wall + x - 4, s ? hub.y - wall - fit : wall + fit, -4.8])
        mirror([0, s ? 0 : 1, 0]) hull() { cube([8, 0.01, 2.8]); translate([0, 0.7, 0.7]) cube([8, 0.01, 1.4]); }
      // post that holds the board down (between the pin rows)
      translate([wall + 30 - 3, hub.y/2 - 3, -(hin.z - 5.2)]) cube([6, 6, hin.z - 5.2]);
    }
    translate([hub.x/2, hub.y/2 - 2.6, 1.6]) linear_extrude(1)
      text("TEMPERATURE ALERT", size = 5, halign = "center", font = FONT);
    translate([-0.01, hub.y/2 - 4, -0.01]) cube([1.6, 8, 1.2]);          // pry notch
  }
}
module hub_lid_print() { translate([0, hub.y, 2.4]) rotate([180, 0, 0]) hub_lid(); }

// ---------- wiper: the alert flag. Its arm sits on the servo horn outside
// the hub's end wall; the "!" tile reaches back over the hub and swings
// from one side of the hub, over the lid, to the other side. ----------
wip_r = 31;                      // tile outer radius from the shaft
module wiper() {                   // axis = Z, arm along +X, tile reaches towards -Z
  difference() {
    union() {
      hull() { cylinder(d = 14, h = 3.2); translate([wip_r - 3, -7, 0]) cube([3, 14, 3.2]); }
      translate([wip_r - 2.4, -7, -24]) cube([2.4, 14, 24 + 3.2]);       // the tile
    }
    translate([0, 0, -1]) cylinder(d = 2.6, h = 6);                       // horn screw
    translate([0, 0, 2.4]) cylinder(d = 5.2, h = 2);                      // its head
    translate([0, 0, -0.01]) hull() { cylinder(d = 7.6, h = 1.6); translate([17.5, 0, 0]) cylinder(d = 4.8, h = 1.6); }
    translate([wip_r - 0.8, 0, -12]) rotate([90, 0, 90]) linear_extrude(1) rotate(180)
      text("!", size = 12, halign = "center", valign = "center", font = FONT);
  }
}
module wiper_print() { translate([0, 0, wip_r]) rotate([0, 90, 0]) wiper(); }

// ---------- assembly ----------
only = "";
w_ang = 60;
show_arm = false;        // animation only: draw a stand-in upper arm through the cuff
module assembly(ang = w_ang, lift = 0) {
  if (only == "" || only == "cuff") color("#e8eef5") cuff();
  if (show_arm) color("#e0b49a") translate([0, 0, -70]) cylinder(r = Rc - 0.6, h = 210, $fn = 96);   // stand-in upper arm (animation only)
  if (only == "" || only == "sensor_lid") color("#2a7de1") multmatrix([[0, 0, -1, bx(skin + dht.z + 0.2)], [-1, 0, 0, bay_u], [0, 1, 0, pocket_z0 - 2 + lift], [0, 0, 0, 1]]) sensor_lid();
  // hub: X along the arm (servo end at z = 0), Y across, Z outwards
  translate([pad_out, -hub.y/2, hub.x]) rotate([0, 90, 0]) {
    if (only == "" || only == "hub") color("#f4f6f8") hub_body();
    if (only == "" || only == "hub_lid") color("#2a7de1") translate([0, 0, hub.z + (only == "" ? 0.2 : 0)]) hub_lid();
    if (only == "" || only == "servo") color("#2b2b2b") translate([hub.x - wall - sg.z, wall + hin.y/2 - sg.x/2, floor_t + ped_h]) {
      cube([sg.z, sg.x, sg.y]);
      translate([sg_tab_top - 2.5, -(sg_tabs - sg.x)/2, 0]) cube([2.5, sg_tabs, sg.y]);
      translate([sg.z, sg.x - sg_shaft_off, sg.y/2]) rotate([0, 90, 0]) { cylinder(d = 11.8, h = 4); translate([0, 0, 0]) cylinder(d = 4.8, h = 7); }
      translate([sg.z, sg.x - sg_shaft_off - 6.5, sg.y/2]) rotate([0, 90, 0]) cylinder(d = 5.5, h = 4);
    }
    if (only == "" || only == "board") color("#3a7d44") translate([wall + board_x, wall + (hin.y - esp.x*0 - esp.y)/2, floor_t + 3.1]) cube([esp.x, esp.y, 1.6]);
    if (only == "" || only == "wiper") color("#f04a3a") translate([hub.x + 5.0, wall + shaft_y, floor_t + shaft_z]) rotate([0, 90, 0]) rotate([0, 0, 270 - ang]) wiper();   // ang 0..180 = the servo sweep; 90 points straight out
  }
}

if (part == "cuff") cuff();
else if (part == "hub") hub_body();
else if (part == "hub_lid") hub_lid_print();
else if (part == "sensor_lid") sensor_lid_print();
else if (part == "wiper") wiper_print();
else if (part == "assembly") assembly();
