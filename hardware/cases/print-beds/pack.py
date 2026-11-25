import trimesh, numpy as np, json, sys, os
S = 'out/stl/'
DEV = {
 'gauge': ['gauge-tub-bell-left', 'gauge-plate-bell-left', 'gauge-mast-bell-left', 'gauge-needle', 'gauge-hanger-for-36mm-bell', 'gauge-printed-bell'],
 'cuff':  ['monitored-cuff-arm-r46', 'monitored-hub', 'monitored-hub_lid', 'monitored-sensor_lid', 'monitored-wiper'],
}
BEDS = {'220x220': (220, 220), 'ups-203x152': (203, 152)}
GAP, M = 6, 4
def load(n):
    m = trimesh.load(S + n + '.stl'); m.apply_translation(-m.bounds[0]); return m
def pack(names, W, H):
    parts = sorted([(n, load(n)) for n in names], key=lambda p: -p[1].extents[0]*p[1].extents[1])
    beds = []
    for n, m in parts:
        placed = False
        for bed in beds + [[]]:
            for rot in (0, 1):
                w, h = (m.extents[0], m.extents[1]) if not rot else (m.extents[1], m.extents[0])
                for y in np.arange(M, H - M - h + 0.01, 2):
                    for x in np.arange(M, W - M - w + 0.01, 2):
                        if all(x + w + GAP <= bx or bx + bw + GAP <= x or y + h + GAP <= by or by + bh + GAP <= y for _, _, bx, by, bw, bh, _ in bed):
                            bed.append((n, m, x, y, w, h, rot)); placed = True; break
                    if placed: break
                if placed: break
            if placed:
                if bed not in beds: beds.append(bed)
                break
        if not placed: print('DOES NOT FIT', n, W, H)
    return beds
os.makedirs('beds/out', exist_ok=True)
summary = {}
for bname, (W, H) in BEDS.items():
    for dev, names in DEV.items():
        solo = [n for n in names if 'plate' in n]      # the dial plate gets colour changes, so it prints alone
        beds = [b for n in solo for b in pack([n], W, H)] + pack([n for n in names if n not in solo], W, H)
        for i, bed in enumerate(beds):
            sc = trimesh.Scene(); allm = []
            for n, m, x, y, w, h, rot in bed:
                mm = m.copy()
                if rot:
                    mm.apply_transform(trimesh.transformations.rotation_matrix(np.pi/2, [0, 0, 1])); mm.apply_translation(-mm.bounds[0])
                mm.apply_translation([x, y, 0]); sc.add_geometry(mm, node_name=n, geom_name=n); allm.append(mm)
            f = 'beds/out/%s-%s-bed%d' % (dev, bname, i + 1)
            sc.export(f + '.3mf'); trimesh.util.concatenate(allm).export(f + '.stl')
            summary[f] = [n for n, *_ in bed]
            print(f, [n for n, *_ in bed], 'max height %.0f' % max(mm.bounds[1][2] for mm in allm))
json.dump(summary, open('beds/out/summary.json', 'w'), indent=1)
