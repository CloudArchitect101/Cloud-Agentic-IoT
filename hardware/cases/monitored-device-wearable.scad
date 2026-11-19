// Monitored device: wearable underarm kit (generic "temperature alert" device)
// Everything here is printed. Only the electronics (ESP32, DHT11, SG90 with
// its horn and screws, wires) are not. Pieces:
//   1. sensor_pod  - holds the bare 4-leg DHT11 against the skin under the arm
//   2. arm_hub     - rides on the upper arm, holds the ESP32 (38-pin DevKitC size)
//                    and the SG90 servo, whose "alert flag" spins while >= 30 C
//   3. strap x2    - printed TPU straps with snap studs (no elastic band to buy)
// Print in PLA or PETG (straps in TPU 95A), 0.2 mm, 3 walls, 20% infill, no supports
// Print hub_lid top-face down (the lip points up on the bed); others as exported.
// Pick a part:  part = "pod" | "pod_lid" | "hub" | "hub_lid" | "flag" | "strap" | "assembly"
part = "assembly";
$fn = 48;

// ---------- Real hardware sizes (mm) ----------
dht = [15.5, 12.2, 5.6];          // DHT11 body (grille face is 15.5 x 12.2)
esp = [55.5, 28.5, 14];           // 38-pin ESP32 with header pins under it
sg90 = [22.8, 12.4, 22.7];        // SG90 body
sg90_flange = 32.4;               // across the screw tabs
band_w = 26;                      // hub loop opening for the printed strap
wall = 2.2;

// ---------- helpers ----------
module rbox(s, r=3) {             // rounded box, corner at origin
  hull() for (x=[r, s.x-r], y=[r, s.y-r]) {
    translate([x, y, 0]) cylinder(r=r, h=s.z);
  }
}
module strap_slots(len, w, z, h=3.2) {  // two slots the band threads through
  for (x=[-1, len+1-4]) translate([x, -1, z]) cube([4, w+2, h]);
}

// ---------- 1. Sensor pod ----------
pod = [40, 26, 9];
lug = 8;                          // strap lug beyond each end of the pod
module sensor_pod() {
  difference() {
    union() {
      rbox(pod, 6);
      // watch-style lugs with a slot each: the strap loops through and snaps back on itself
      for (x=[-lug+0.5, pod.x-0.5]) translate([x, 0, 0]) rbox([lug, pod.y, 4], 2);
    }
    for (x=[-lug/2-1.2+0.5, pod.x+lug/2-1.2-0.5]) translate([x, (pod.y-strap_w-1)/2, -1]) cube([2.4, strap_w+1, 10]);
    // DHT11 pocket, open on top (outside); grille faces the skin (bottom)
    translate([(pod.x-dht.x)/2-0.3, (pod.y-dht.y)/2-0.3, 1.6]) cube([dht.x+0.6, dht.y+0.6, 20]);
    // skin-side vents in front of the grille
    for (i=[0:3]) translate([(pod.x-dht.x)/2+1.5+i*3.4, (pod.y-dht.y)/2+1.5, -1]) cube([1.8, dht.y-3, 4]);
    // leg / wire exit toward the hub
    translate([pod.x/2-4, pod.y-4, 3.2]) cube([8, 6, 10]);
  }
}

// ---------- 3. Printed strap (print 2 in TPU 95A) ----------
// Each strap joins the hub to the pod. Each end threads through a hub loop or
// pod lug, folds back, and its two studs snap into two of its holes, so the
// fit adjusts in 8 mm steps. Two straps + hub + pod go round the upper arm.
strap_w = 22; strap_t = 1.6; strap_len = 190;
stud_x = [6, 14];                         // from each end
hole_x = [for (i=[0:5]) 30 + i*8];        // from each end
module strap() {
  difference() {
    hull() for (x=[strap_w/2, strap_len-strap_w/2]) translate([x, strap_w/2, 0]) cylinder(d=strap_w, h=strap_t);
    for (end=[0, 1], hx=hole_x) translate([end ? strap_len-hx : hx, strap_w/2, -1]) cylinder(d=3.7, h=5);
  }
  for (end=[0, 1], sx=stud_x) translate([end ? strap_len-sx : sx, strap_w/2, strap_t]) {
    cylinder(d=3.3, h=1.7);                       // neck (= one strap thickness)
    translate([0, 0, 1.6]) cylinder(d1=4.8, d2=3.6, h=1.2);   // snap head
  }
}

module pod_lid() {               // snap-in lid that presses the DHT11 down
  difference() {
    union() {
      rbox([pod.x-12, pod.y-4, 1.6], 3);
      translate([(pod.x-12-dht.x)/2+0.4, (pod.y-4-dht.y)/2+0.4, 1.6]) cube([dht.x-0.2, dht.y-0.2, 1.4]);
    }
    translate([(pod.x-12)/2-3.5, pod.y-4-3, -1]) cube([7, 4, 5]);   // wire notch
  }
}

// ---------- 2. Arm hub ----------
hub_in = [esp.x+3, esp.y+3, 24];
hub = [hub_in.x+2*wall, hub_in.y+2*wall, hub_in.z+wall];
module arm_hub() {
  difference() {
    rbox(hub, 4);
    translate([wall, wall, wall]) cube(hub_in + [0, 0, 5]);
    // USB-C / micro-USB opening on the short end
    translate([-1, hub.y/2-6, wall+1.5]) cube([wall+2, 12, 8]);
    // sensor wire entry on the other short end
    translate([hub.x-wall-1, hub.y/2-3, wall+10]) cube([wall+2, 6, 5]);
    // band channel under the floor: band passes through two side tunnels
    for (x=[6, hub.x-6-band_w]) translate([x, -1, -0.01]) cube([band_w, hub.y+2, 0.01]);
  }
  // band loops on the floor's two long sides
  for (y=[-5, hub.y]) translate([hub.x/2-band_w/2-3, y, 0]) difference() {
    cube([band_w+6, 5, 6]);
    translate([3, -1, 1.6]) cube([band_w, 7, 2.8]);
  }
}
module hub_lid() {               // lip points down into the hub; text is engraved on top
  color("#2a7de1") difference() {
    union() {
      rbox([hub.x, hub.y, 2.4], 4);
      translate([wall+0.25, wall+0.25, -3]) difference() {
        cube([hub_in.x-0.5, hub_in.y-0.5, 3]);
        translate([1.6, 1.6, -1]) cube([hub_in.x-3.7, hub_in.y-3.7, 5]);
      }
    }
    // SG90 goes through the lid body-down, its tabs rest on the lid
    translate([hub.x-12-sg90.x, (hub.y-sg90.y)/2, -5]) cube([sg90.x+0.6, sg90.y+0.6, 10]);
    for (dx=[-(sg90_flange-sg90.x)/2+2.3, sg90.x+(sg90_flange-sg90.x)/2-2.3])
      translate([hub.x-12-sg90.x+dx, hub.y/2+0.3, -5]) cylinder(d=1.8, h=10);
    translate([5, wall+2.2, 1.8]) linear_extrude(1)
      text("TEMPERATURE ALERT", size=3.4, font="Liberation Sans:style=Bold");
  }
}

// Alert flag: press-fits on the SG90 single-arm horn (glue or 2 mm screw)
module alert_flag() {
  difference() {
    union() {
      hull() { cylinder(d=9, h=2); translate([30, 0, 0]) cylinder(d=6, h=2); }
      translate([22, -9, 0]) rbox([16, 18, 2], 3);    // the flag that spins
      translate([30, 0, 2]) linear_extrude(0.8) text("!", size=11, halign="center", valign="center",
                                                     font="Liberation Sans:style=Bold");
    }
    translate([0, 0, -1]) cylinder(d=2.4, h=5);                 // horn screw
    translate([0, -2.6, 1]) hull() { cylinder(d=5.2, h=2); translate([14, 0, 0]) cylinder(d=4, h=2); }
  }
}

// ---------- assembly preview: the kit laid out flat ----------
module assembly() {
  translate([lug, 0, 0]) {
    color("#e8eef5") sensor_pod();
    color("#2a7de1") translate([6, 3, pod.z+3]) pod_lid();
  }
  translate([70, -10, 0]) {
    color("#e8eef5") arm_hub();
    translate([0, 0, hub.z+0.2]) hub_lid();
    color("#1d2733") translate([5, wall+2.2, hub.z+2.0]) linear_extrude(0.7) text("TEMPERATURE ALERT", size=3.4, font="Liberation Sans:style=Bold");
    color("#333") translate([hub.x-12-sg90.x+0.3, (hub.y-sg90.y)/2+0.3, hub.z+2.6]) cube([sg90.x, sg90.y, 4.5]);
    color("#f04a3a") translate([hub.x-12-5.9, hub.y/2, hub.z+9]) rotate([0, 0, 150]) alert_flag();
  }
  color("#3a3f47") for (i=[0, 1]) translate([-10, -40 - i*30, 0]) strap();
}

if (part == "pod") sensor_pod();
else if (part == "pod_lid") pod_lid();
else if (part == "hub") arm_hub();
else if (part == "hub_lid") hub_lid();
else if (part == "flag") alert_flag();
else if (part == "strap") strap();
else assembly();
