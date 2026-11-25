import trimesh, numpy as np, os
S='out/stl/'
R=trimesh.transformations.rotation_matrix
def load(n):
    m=trimesh.load(S+n+'.stl'); m.apply_translation(-m.bounds[0]); return m
def rotz(m):
    m=m.copy(); m.apply_transform(R(np.pi/2,[0,0,1])); m.apply_translation(-m.bounds[0]); return m
def at(m,x,y):
    m=m.copy(); m.apply_translation([x,y,0]); return m
L=[('PLATE',3,3,0),('gauge-tub-bell-left',3,33,0),('monitored-cuff-arm-r46',3,123,0),('gauge-needle',168,3,1),('gauge-mast-bell-left',164,118,0),('monitored-hub',3,211,0),('monitored-hub_lid',118,123,1),('gauge-hanger-for-36mm-bell',203,3,0),('gauge-printed-bell',203,46,0),('monitored-sensor_lid',95,215,0),('monitored-wiper',203,77,0)]
sc=trimesh.Scene(); allm=[]; boxes=[]
for n,x,y,r in L:
    if n=='PLATE':
        m=load('gauge-plate-bell-left'); m.apply_transform(R(np.pi/2,[1,0,0])); m.apply_translation(-m.bounds[0]); m=at(m,x+5,y+10); n='gauge-plate-standing'
    else:
        m=load(n); m=rotz(m) if r else m; m=at(m,x,y)
    sc.add_geometry(m,node_name=n,geom_name=n); allm.append(m); boxes.append((n,m.bounds))
    m.export('beds/x2d/st_%s.stl'%n)
b=trimesh.util.concatenate(allm).bounds; print('bounds',b.round(1))
for i in range(len(boxes)):
  for j in range(i+1,len(boxes)):
    a,c=boxes[i][1],boxes[j][1]
    if not(a[1][0]+3<=c[0][0] or c[1][0]+3<=a[0][0] or a[1][1]+3<=c[0][1] or c[1][1]+3<=a[0][1]): print('CLOSE',boxes[i][0],boxes[j][0])
sc.export('beds/x2d/all-parts-x2d-plate-standing.3mf'); trimesh.util.concatenate(allm).export('beds/x2d/all-parts-x2d-plate-standing.stl')
