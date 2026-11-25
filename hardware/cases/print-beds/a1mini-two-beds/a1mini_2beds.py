import trimesh, numpy as np
S='out/stl/'; R=trimesh.transformations.rotation_matrix
def load(n):
    m=trimesh.load(S+n+'.stl'); m.apply_translation(-m.bounds[0]); return m
def rotz(m):
    m=m.copy(); m.apply_transform(R(np.pi/2,[0,0,1])); m.apply_translation(-m.bounds[0]); return m
def at(m,x,y): m=m.copy(); m.apply_translation([x,y,0]); return m
def plate_standing_y():
    m=load('gauge-plate-bell-left'); m.apply_transform(R(np.pi/2,[1,0,0])); m.apply_translation(-m.bounds[0]); return rotz(m)
beds={
 'a1mini-oneset-bed1':[('gauge-tub-bell-left',at(load('gauge-tub-bell-left'),3,3)),('monitored-cuff-arm-r46',at(load('monitored-cuff-arm-r46'),3,92)),
   ('monitored-sensor_lid',at(load('monitored-sensor_lid'),116,92)),('gauge-hanger-for-36mm-bell',at(load('gauge-hanger-for-36mm-bell'),116,122)),
   ('gauge-printed-bell',at(load('gauge-printed-bell'),146,127)),('monitored-wiper',at(load('monitored-wiper'),146,157))],
 'a1mini-oneset-bed2':[('gauge-mast-bell-left',at(load('gauge-mast-bell-left'),3,3)),('monitored-hub',at(rotz(load('monitored-hub')),75,3)),
   ('gauge-plate-standing',at(plate_standing_y(),118+10,3+5)),('monitored-hub_lid',at(load('monitored-hub_lid'),3,136)),('gauge-needle',at(rotz(load('gauge-needle')),147,3))]}
for name,items in beds.items():
    sc=trimesh.Scene(); allm=[]
    for n,m in items: sc.add_geometry(m,node_name=n,geom_name=n); allm.append(m); m.export('beds/x2d/%s_%s.stl'%(name,n))
    b=trimesh.util.concatenate(allm).bounds; print(name,b.round(1))
    bx=[(n,m.bounds) for n,m in items]
    for i in range(len(bx)):
      for j in range(i+1,len(bx)):
        a,c=bx[i][1],bx[j][1]
        if not(a[1][0]+3<=c[0][0] or c[1][0]+3<=a[0][0] or a[1][1]+3<=c[0][1] or c[1][1]+3<=a[0][1]): print(' CLOSE',bx[i][0],bx[j][0])
    sc.export('beds/x2d/%s.3mf'%name); trimesh.util.concatenate(allm).export('beds/x2d/%s.stl'%name)
