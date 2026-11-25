import trimesh, numpy as np, os
S='out/stl/'
def load(n):
    m=trimesh.load(S+n+'.stl'); m.apply_translation(-m.bounds[0]); return m
def rotz(m):
    m=m.copy(); m.apply_transform(trimesh.transformations.rotation_matrix(np.pi/2,[0,0,1])); m.apply_translation(-m.bounds[0]); return m
def at(m,x,y,z=0):
    m=m.copy(); m.apply_translation([x,y,z]); return m
SX,SY=3,3
under=[at(load('gauge-mast-bell-left') if load('gauge-mast-bell-left').extents[0]>100 else rotz(load('gauge-mast-bell-left')),SX,SY),
       at(load('gauge-needle'),SX,SY+72),
       at(load('monitored-hub_lid'),SX,SY+72+34),
       at(load('gauge-hanger-for-36mm-bell'),SX+114,SY+72)]
for m in under: assert m.bounds[1][0]<=SX+141 and m.bounds[1][1]<=SY+150, m.bounds
top=max(m.bounds[1][2] for m in under); GAPZ=1.0
plate=rotz(load('gauge-plate-bell-left')); plate=at(plate,SX,SY,top+GAPZ)
stack=trimesh.util.concatenate(under+[plate])
others={'gauge-tub':at(load('gauge-tub-bell-left'),3,157),
        'monitored-cuff-r46':at(rotz(load('monitored-cuff-arm-r46')),148,3),
        'monitored-hub':at(rotz(load('monitored-hub')),162,116),
        'gauge-printed-bell':at(load('gauge-printed-bell'),204,116),
        'monitored-wiper':at(load('monitored-wiper'),204,146),
        'monitored-sensor_lid':at(load('monitored-sensor_lid'),162,206)}
allm=[stack]+list(others.values())
b=trimesh.util.concatenate(allm).bounds; print('bounds',b.round(1),'plate z',round(top+GAPZ,1))
# collision check in 2D bboxes for non-stack items
boxes=[(SX,SY,SX+141,SY+150)]+[tuple(m.bounds[0][:2])+tuple(m.bounds[1][:2]) for m in others.values()]
for i in range(len(boxes)):
  for j in range(i+1,len(boxes)):
    a,c=boxes[i],boxes[j]
    if not(a[2]+3<=c[0] or c[2]+3<=a[0] or a[3]+3<=c[1] or c[3]+3<=a[1]): print('OVERLAP',i,j)
sc=trimesh.Scene(); sc.add_geometry(stack,node_name='dial-plate-stack',geom_name='dial-plate-stack')
for n,m in others.items(): sc.add_geometry(m,node_name=n,geom_name=n)
os.makedirs('beds/x2d',exist_ok=True)
sc.export('beds/x2d/all-parts-x2d-one-plate.3mf'); trimesh.util.concatenate(allm).export('beds/x2d/all-parts-x2d-one-plate.stl')
stack.export('beds/x2d/dial-plate-stack.stl')
