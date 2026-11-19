// Corp (internal) device: desk "ticket gauge" with a hanging bell
// The SG90 shaft comes through the dial; the printed needle rides on its horn.
//  - Today (firmware 2.7.0) the needle sweeps the whole dial, faster as more
//    high-temperature tickets wait, and its striker taps the bell at the right
//    end of every sweep: more tickets = faster ringing.
//  - With the optional "gauge mode" firmware change it would instead stop at
//    the level for the open-ticket count and tap the bell once per new ticket.
// Everything is printed: body, back, needle with a flexible striker, the
// gallows "stick", a hanger, the bell and its clapper. Only the electronics
// (ESP32, SG90 with its horn and screws, USB cable) are not.
// A PLA bell gives a short bright "tink", not a long metal ring: print it in
// PLA, 3 walls, 100% infill, and let it hang free so it can swing and chime.
// Print PLA/PETG, 0.2 mm, no supports: body standing on its open back
// (dial vertical, so the box roof needs no bridge); the other parts flat.
// Dial colours: paint the bands, or pause/change filament for the raised art.
// part = "body" | "back" | "needle" | "gallows" | "hanger" | "bell" | "clapper" | "assembly"
part = "assembly";
$fn = 64;

W  = 116;      // width (= dial diameter)
R  = W/2;      // dial radius
Hb = 62;       // box height = dial centre height
D  = 52;       // box depth behind the dial
t  = 3;        // dial plate thickness (front)
wall = 2.4;

sg90 = [22.8, 12.4];        // body footprint
shaft_from_end = 5.9;       // shaft centre to the near end of the body
tab_hole = 2.4;             // screw hole beyond each body end
needle_len = 52;
striker_len = 15;            // tongue beyond the needle tip
FONT = "Liberation Sans:style=Bold";

// level -> angle (deg from the right horizontal); 0 tickets at the left
function lvl_angle(L) = 180 - L*34;          // 0..5+ spans 180..10 deg; 0-10 = bell zone

// put 2D artwork (drawn in x/y) onto the front face of the dial (x/z plane)
module on_face(h=1) {
  translate([0, -t, Hb]) rotate([90, 0, 0]) linear_extrude(h) children();
}

module dial_outline_2d() {
  union() {
    intersection() { circle(r=R); translate([-R, 0]) square([W, R]); }
    translate([-R, -Hb]) square([W, Hb]);
  }
}

module servo_cut_2d() {         // in face coordinates (origin = dial centre)
  translate([-sg90.y/2-0.3, shaft_from_end - sg90.x - 0.3]) square([sg90.y+0.6, sg90.x+0.6]);
  for (zz=[shaft_from_end + tab_hole, shaft_from_end - sg90.x - tab_hole]) translate([0, zz]) circle(d=1.8);
}

module body() {
  color("#eef2f6") difference() {
    union() {
      // dial plate
      translate([0, 0, Hb]) rotate([90, 0, 0]) linear_extrude(t) dial_outline_2d();
      // box behind the dial
      translate([-R, 0, 0]) difference() {
        cube([W, D, Hb]);
        translate([wall, -1, wall]) cube([W-2*wall, D-wall+1, Hb-2*wall]);  // open back
      }
    }
    // servo through the dial
    translate([0, 1, Hb]) rotate([90, 0, 0]) linear_extrude(t+2) servo_cut_2d();
    // room for the top of the servo above the box
    translate([-sg90.y/2-1, -0.1, Hb-wall-1]) cube([sg90.y+2, 18, wall+2]);
    // USB cable notch on the right side
    translate([R-wall-1, D-16, wall+2]) cube([wall+2, 12, 8]);
    // gallows post socket on top, right-rear
    translate([R-11, D-14, Hb-6]) cube([6.4, 6.4, 10]);
    // open the back edge so the cover drops in
    translate([-R+wall-0.01, D-wall-0.01, wall]) cube([W-2*wall+0.02, wall+1, Hb-2*wall]);
  }
  // ---- raised artwork on the dial ----
  color("#1d2733") on_face(1) {
    // outer rim
    difference() { circle(r=R-2); circle(r=R-4); translate([-R, -R]) square([W, R]); }
    // tick marks and level numbers
    for (L=[0:5]) rotate(lvl_angle(L)) translate([R-15, -1.2]) square([9, 2.4]);
    for (L=[0:5]) rotate(lvl_angle(L)) translate([R-23, 0]) rotate(-lvl_angle(L))
      text(L==5 ? "5+" : str(L), size=6, halign="center", valign="center", font=FONT);
    // minor ticks
    for (a=[180:-6.8:10]) rotate(a) translate([R-10, -0.5]) square([4, 1]);
    // bell zone marker at the right end
    rotate(5) translate([R-14, 0]) circle(d=4);
    // title on the box front
    translate([0, -27]) text("HIGH TEMPERATURE", size=6.2, halign="center", font=FONT);
    translate([0, -37]) text("TICKETS", size=6.2, halign="center", font=FONT);
    // left and right arrows: fewer <-- --> more
    translate([-R+8, -51]) { polygon([[0,0],[8,5],[8,2],[18,2],[18,-2],[8,-2],[8,-5]]);
                             translate([21, -2.2]) text("FEW", size=4.5, font=FONT); }
    translate([R-8, -51]) { polygon([[0,0],[-8,5],[-8,2],[-18,2],[-18,-2],[-8,-2],[-8,-5]]);
                            translate([-21, -2.2]) text("MANY", size=4.5, halign="right", font=FONT); }
  }
  // coloured level bands (print with a filament change at the first layer, or paint)
  for (b=[[0,2,"#3cb371"],[2,4,"#f2b632"],[4,5,"#e5483c"]]) color(b[2]) on_face(0.6)
    intersection() {
      difference() { circle(r=R-5); circle(r=R-9); }
      polygon([[0,0], for (a=[lvl_angle(b[0]):-2:lvl_angle(b[1])]) [2*R*cos(a), 2*R*sin(a)],
               [2*R*cos(lvl_angle(b[1])), 2*R*sin(lvl_angle(b[1]))]]);
    }
}

module back_cover() {
  difference() {
    cube([W-2*wall-0.4, wall, Hb-2*wall-0.4]);
    for (x=[10:8:W-20]) translate([x, -1, 8]) cube([3, wall+2, Hb-24]);   // vents
  }
}

module needle_2d() {
  difference() {
    union() {
      circle(d=12);
      polygon([[0, 3.5], [needle_len-6, 1.2], [needle_len, 0], [needle_len-6, -1.2], [0, -3.5]]);
      translate([-12, 0]) circle(d=7);                     // counterweight tail
      translate([-12, -2]) square([12, 4]);
      // flexible printed striker: a thin tongue that bends when it hits the bell
      translate([needle_len-2, -0.55]) square([striker_len, 1.1]);
      translate([needle_len+striker_len, 0]) circle(d=3.6);
    }
    circle(d=2.6);                                        // horn screw
  }
}
module needle() {
  difference() {
    linear_extrude(2.4) needle_2d();
    // pocket for the single-arm horn on the back
    translate([0, 0, -0.01]) linear_extrude(1.3) hull() { circle(d=7.2); translate([15, 0]) circle(d=4.2); }
  }
}

// Gallows: the "stick on top" the bell hangs from
gallows_h = 62;
post_xy = [R-11.2, D-14.2];                 // where the post sits (socket on the box top)
bell_xy = [78, -t-13.3];                     // bell centre: in the needle's plane, past its tip
arm_end = bell_xy - post_xy - [3, 3];
slot = [6.6, 2.6];                           // twist-lock slot for the hanger's T head
module gallows() {
  difference() {
    union() {
      cube([6, 6, gallows_h + 6]);                         // post (6 mm into the socket)
      translate([3, 3, gallows_h]) hull() { cylinder(d=7, h=6); translate(arm_end) cylinder(d=10, h=6); }
    }
    translate([3, 3, gallows_h-1]) translate(arm_end) cube([slot.x, slot.y, 20], center=true);
  }
}
module gallows_print() { gallows(); }

// Hanger: printed flat. T head goes up through the arm's slot, turn it 90
// degrees so it rests on top; the bell's loop hangs on the open hook below.
hanger_len = 40;
module hanger_2d() {
  translate([-3, 0]) square([6, 2.4]);                        // T head (rests on the arm)
  translate([-1.2, -hanger_len]) square([2.4, hanger_len]);   // stem through the slot
  translate([0, -hanger_len]) difference() {                  // open J hook
    circle(d=9); circle(d=4.6); translate([0, -0.5]) square([6, 6]);
  }
}
module hanger() { linear_extrude(2.0) hanger_2d(); }

// Bell: printed mouth-down, thin wall, loop on the crown, twist-lock slot inside for the clapper
bell_h = 24; bell_r = 13; bell_wall = 1.4;
module bell_profile(off=0) {
  polygon([[0, 0], [bell_r-off, 0], [bell_r-1.5-off, 4], [7.5-off, bell_h-5], [5-off, bell_h-1.5-off],
           [0, bell_h-off]]);
}
module bell() {
  difference() {
    rotate_extrude() bell_profile(0);
    translate([0, 0, -0.01]) rotate_extrude() bell_profile(bell_wall);
    translate([0, 0, bell_h-3]) cube([4.8, 2.4, 10], center=true);     // clapper slot
  }
  translate([0, 0, bell_h+3.2]) rotate([90, 0, 0]) difference() {      // hanging loop
    cylinder(d=9, h=2.4, center=true); cylinder(d=4.4, h=4, center=true);
  }
  // fill under the loop so it joins the crown
  translate([-2.5, -1.2, bell_h-1.5]) cube([5, 2.4, 2.5]);
}
// Clapper: printed flat; its T head goes up through the crown slot from inside, turn 90 degrees
module clapper() {
  linear_extrude(2.0) {
    translate([-2.2, 0]) square([4.4, 1.8]);              // T head
    translate([-0.9, -15]) square([1.8, 15]);             // stem
    translate([0, -17.5]) circle(d=6);                    // clapper ball (flat disc)
  }
}

module assembly(theta=40) {
  body();
  color("#c9d2dc") translate([-R+wall+0.2, D-wall, wall+0.2]) back_cover();
  color("#2b2b2b") translate([-sg90.y/2, -t-12, Hb+shaft_from_end-sg90.x]) cube([sg90.y, 12, sg90.x]);
  color("#e5483c") translate([0, -t-14.5, Hb]) rotate([0, -theta, 0]) rotate([90, 0, 0]) needle();
  color("#9aa6b2") translate([post_xy.x, post_xy.y, Hb-6]) gallows_print();
  arm_top = Hb - 6 + gallows_h + 6;
  color("#9aa6b2") translate([bell_xy.x, bell_xy.y + 1, arm_top + 2.4]) rotate([90, 0, 0]) hanger();
  bell_z = arm_top + 2.4 - hanger_len - 4.5 - bell_h - 3.2;   // loop resting in the hook
  color("#f2b632") translate([bell_xy.x, bell_xy.y, bell_z]) bell();
}

if (part == "body") body();
else if (part == "back") back_cover();
else if (part == "needle") needle();
else if (part == "gallows") gallows_print();
else if (part == "hanger") hanger();
else if (part == "bell") bell();
else if (part == "clapper") clapper();
else assembly();
