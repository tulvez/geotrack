// Tulvez Harita — Mavi Ok Kuralları (ayrı dosya, mevcut davranış korunuyor)
// NavigationMap'ten çıkarıldı, davranış birebir aynı kalacak

/**
 * Yol bearing hesaplar — dönüş sıçramasını önlemek için ileriye bakıp ortalar
 * t: 0..1 progressRatio
 * Tek segmente bakmak kavşakta 90° sıçratıyordu; şimdi ~60m pencere ortalaması
 */
export function getRoadBearing(geometry, t) {
  if (!geometry?.coordinates?.length) return null
  try {
    const coords = geometry.coordinates
    const n = coords.length - 1
    if (n < 1) return null
    const idx = Math.max(0, Math.min(Math.floor(t * n), n - 1))
    // İleriye doğru ~60m'lik pencere topla (dönüş öncesi erken yumuşama)
    let sx = 0, sy = 0, totalW = 0
    const maxLook = Math.min(n, idx + 6)
    for (let i = idx; i < maxLook; i++) {
      const a = coords[i], b = coords[i + 1]
      if (!a || !b) continue
      const dLng = b[0] - a[0]
      const dLat = b[1] - a[1]
      const len = Math.hypot(dLng, dLat)
      if (len < 1e-9) continue
      // Yakın segment ağırlıklı (önceki davranışa sadık, ama dönüşü yumuşat)
      const w = 1 / (1 + (i - idx) * 0.6)
      sx += (dLng / len) * w
      sy += (dLat / len) * w
      totalW += w
      // ~60m pencere: dereceyi metreye kabaca çevir (TR enleminde)
      if (totalW > 2.2) break
    }
    if (totalW < 1e-9) {
      // Fallback: tek segment (eski davranış)
      const a = coords[idx], b = coords[Math.min(idx + 1, n)]
      if (!a || !b) return null
      const dLng = b[0] - a[0], dLat = b[1] - a[1]
      if (Math.abs(dLng) < 1e-9 && Math.abs(dLat) < 1e-9) return null
      return (Math.atan2(dLng, dLat) * 180 / Math.PI + 360) % 360
    }
    return (Math.atan2(sx / totalW, sy / totalW) * 180 / Math.PI + 360) % 360
  } catch { return null }
}

/**
 * Tam segment bearing (tek segment, geleceğe bakmaz)
 * Ok için: düz yolda ok tam yola paralel olsun diye
 */
export function getSegmentBearing(geometry, t) {
  if (!geometry?.coordinates?.length) return null
  try {
    const coords = geometry.coordinates
    const n = coords.length - 1
    if (n < 1) return null
    const idx = Math.max(0, Math.min(Math.floor(t * n), n - 1))
    const a = coords[idx]
    const b = coords[Math.min(idx + 1, n)]
    if (!a || !b) return null
    const dLng = b[0] - a[0]
    const dLat = b[1] - a[1]
    if (Math.abs(dLng) < 1e-9 && Math.abs(dLat) < 1e-9) return null
    return (Math.atan2(dLng, dLat) * 180 / Math.PI + 360) % 360
  } catch { return null }
}

/** Açısal fark -180..180 */
export function angleDiff(from, to) {
  let d = (to - from) % 360
  if (d > 180) d -= 360
  if (d < -180) d += 360
  return d
}

/** Açısal lerp */
export function lerpAngle(current, target, t) {
  return (current + angleDiff(current, target) * t + 360) % 360
}

/**
 * Max dönüş hızı ile yumuşat: bisiklet/araba 1 karede 90° dönemez,
 * o yüzden ani 90° sıçramayı kare başına maxRate ile kıs
 */
export function clampTurnRate(prev, target, maxDeg) {
  const d = angleDiff(prev, target)
  if (Math.abs(d) <= maxDeg) return (target + 360) % 360
  return (prev + Math.sign(d) * maxDeg + 360) % 360
}

/**
 * Ok rotasyonu: yol bearing - harita bearing (viewport-sabit)
 * Harita dönse bile ok yola paralel kalır
 */
export function computeArrowRotation(routeBearing, mapBearing) {
  let rot = (routeBearing ?? 0) - (mapBearing ?? 0)
  rot = ((rot + 540) % 360) - 180
  return rot
}

/**
 * Ok eğimi: 3D modda pitch'e göre hafif yatık
 */
export function computeArrowTilt(show3D, navigating, mapPitch) {
  if (show3D || navigating) {
    return Math.min(25, (mapPitch || 0) * 0.45)
  }
  return 0
}
