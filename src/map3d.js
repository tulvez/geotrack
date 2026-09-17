// Tulvez Harita — 3D Kuralları (ayrı dosya, mevcut davranış korunuyor)
// NavigationMap'ten çıkarıldı, davranış birebir aynı kalacak

/**
 * 3D bina katmanını ekle
 * Stil yüklendikten sonra çağrılır, show3D false ise gizli başlar
 */
export function add3dBuildings(map, show3D) {
  const layer = map.getStyle()?.layers?.find(l => l.id === 'water')
  if (!layer) return
  try {
    map.addLayer({
      id: '3d-buildings', source: 'openmaptiles', 'source-layer': 'building',
      type: 'fill-extrusion', minzoom: 14,
      paint: {
        'fill-extrusion-color': ['interpolate', ['linear'], ['get', 'render_height'],
          0, '#e2e8f0', 20, '#cbd5e1', 40, '#94a3b8', 60, '#64748b'],
        'fill-extrusion-height': ['get', 'render_height'],
        'fill-extrusion-base': ['get', 'render_min_height'],
        'fill-extrusion-opacity': 0.7, 'fill-extrusion-vertical-gradient': true,
      },
    }, layer.id)
    if (!show3D) map.setLayoutProperty('3d-buildings', 'visibility', 'none')
  } catch {}
}

/**
 * 3D toggle: pitch 60 ve bina görünürlüğü
 */
export function toggle3DState(map, show3D, setShow3D) {
  if (!map) return
  const w = !show3D; setShow3D(w)
  try {
    if (w) { map.setPitch(60, { duration: 600 }); map.setLayoutProperty('3d-buildings', 'visibility', 'visible') }
    else { map.setPitch(0, { duration: 500 }); map.setLayoutProperty('3d-buildings', 'visibility', 'none') }
  } catch {}
}

/**
 * Navigasyon 3D pitch değerleri
 */
export const NAV_PITCH = 55
export const DEFAULT_PITCH_3D = 60
export const DEFAULT_PITCH_2D = 0
