import { useState, useRef, useCallback, useEffect } from 'react'
import { PositionKalman } from './kalman.js'
import KalmanFilter from './vendor/kalmanjs.js' // wouterbulten/kalmanjs (MIT, vendored) — hız kanalı

// Tam teşekküllü self-host GPS takibi (motora dokunmaz, dış çağrı yok):
// Kalman + innovation gate + watchdog + ivmeölçer kilidi + 60fps dead-reckoning + warm-start

const FALLBACK_INTERVAL = 5000
const WATCHDOG_MS = 12000
const STATIONARY_SPEED = 0.8
const BREAKOUT_SPEED = 1.2
const FREEZE_MOVE_M = 6

function toRadF(d) { return (d * Math.PI) / 180 }
function haversineF(a, b) {
  const R = 6371000
  const dLat = toRadF(b.lat - a.lat)
  const dLng = toRadF(b.lng - a.lng)
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRadF(a.lat)) * Math.cos(toRadF(b.lat)) * Math.sin(dLng / 2) ** 2
  return R * 2 * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s))
}

export function useUserLocation() {
  const [location, setLocation] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [permission, setPermission] = useState('prompt')
  const watchId = useRef(null)
  const kalman = useRef(null)
  const lastFixTime = useRef(0)
  const lastPublish = useRef(null)
  const frozen = useRef(null) // durağan kilit konumu
  const frozenSince = useRef(0)
  const wasMoving = useRef(false)
  const animFrameId = useRef(null)
  const fallbackIntervalId = useRef(null)
  const watchdogIntervalId = useRef(null)
  const wakeLock = useRef(null)
  const accelRef = useRef({ lastMag: 0, stillMs: 0, lastT: 0, active: false })
  const speedKf = useRef(null) // vendored kalmanjs: ham GPS hızındaki zıplamayı yumuşatır
  const smoothSpeed = useCallback((raw, accuracy) => {
    if (raw == null || isNaN(raw)) return raw
    if (!speedKf.current) speedKf.current = new KalmanFilter({ R: 0.8, Q: 2 })
    // Doğruluk kötüyse ölçüme az güven (Q büyüt)
    speedKf.current.setMeasurementNoise(1 + (accuracy ?? 10) / 10)
    return speedKf.current.filter(raw)
  }, [])
  const locRef = useRef(null)
  useEffect(() => { locRef.current = location }, [location])

  const publish = useCallback((fix) => {
    // Durağan kilit: donmuşken mikro yayını yut (render fırtınası biter)
    if (frozen.current) {
      const d = haversineF(frozen.current, fix)
      if (d < 1.5) return
    }
    const prev = lastPublish.current
    if (prev && !fix.predicted) {
      // Aynı karenin tekrarıysa at
      if (Math.abs(prev.lat - fix.lat) < 1e-9 && Math.abs(prev.lng - fix.lng) < 1e-9) return
    }
    lastPublish.current = fix
    setLocation(fix)
    setPermission('granted')
    setLoading(false)
  }, [])

  const feedGps = useCallback((lat, lng, heading, speed, accuracy, timestamp) => {
    const now = timestamp || Date.now()
    if (!kalman.current) kalman.current = new PositionKalman()
    const kf = kalman.current
    const acc = accuracy ?? 12

    // İlk fix: hız tohumlamalı başlat (velocity seeding)
    if (!kf.hasAnchor) {
      const s0 = smoothSpeed(speed, acc) ?? speed
      kf.seed(lat, lng, acc, s0, heading, now)
      lastFixTime.current = now
      const st = kf.getState()
      const h = heading != null && !isNaN(heading) && (s0 ?? 0) > 1 ? heading : st?.heading ?? heading
      const s = s0 ?? st?.speed ?? 0
      publish({ lat: st?.lat ?? lat, lng: st?.lng ?? lng, heading: h, speed: s, accuracy: acc, predicted: false, timestamp: now })
      wasMoving.current = s > STATIONARY_SPEED
      return
    }

    // Çok kötü doğruluk: KF'yi bozma, DR'de kal (50m+ çöp)
    if (acc > 50) return

    const ok = kf.update(lat, lng, acc, now)
    if (!ok) return // innovation gate reddetti (sıçrama) — tahminde kal
    lastFixTime.current = now
    const st = kf.getState()
    if (!st) return
    const gpsSpeed = smoothSpeed(speed ?? st.speed, acc) ?? st.speed
    // İvmeölçer + hız ile durağan kilidi (hysteresis)
    const moving = gpsSpeed > STATIONARY_SPEED || (accelRef.current.active && accelRef.current.stillMs < 1500)
    if (!moving) {
      if (!frozen.current) {
        frozen.current = { lat: st.lat, lng: st.lng }
        frozenSince.current = now
      }
      // Kilitliyken konumu dondur, sadece ilk kareyi yayınla
      if (wasMoving.current) {
        wasMoving.current = false
        publish({ lat: frozen.current.lat, lng: frozen.current.lng, heading: heading ?? st.heading, speed: 0, accuracy: acc, predicted: false, timestamp: now })
      }
      return
    }
    // Breakout: duruştan harekete → kovaryans şişir (1sn gecikme olmaz)
    if (!wasMoving.current && gpsSpeed > BREAKOUT_SPEED) {
      kf.boost()
      wasMoving.current = true
      frozen.current = null
    } else if (wasMoving.current && frozen.current) {
      // Hareketliyken kilit kalmasın
      const d = haversineF(frozen.current, { lat: st.lat, lng: st.lng })
      if (d > 2 || gpsSpeed > BREAKOUT_SPEED) frozen.current = null
    }
    // Kilitliyken 6m+ gerçek hareket yoksa yayınlama
    if (frozen.current) {
      const d = haversineF(frozen.current, { lat: st.lat, lng: st.lng })
      if (d < FREEZE_MOVE_M && gpsSpeed < BREAKOUT_SPEED) return
      frozen.current = null
    }
    const h = heading != null && !isNaN(heading) && gpsSpeed > 1 ? heading : st.heading ?? heading
    publish({ lat: st.lat, lng: st.lng, heading: h, speed: gpsSpeed, accuracy: acc, predicted: false, timestamp: now })
  }, [publish])

  // 60fps dead-reckoning: GPS arası KF hızıyla tahmin (sadece hareketliyken)
  const updatePrediction = useCallback(() => {
    const kf = kalman.current
    if (kf && kf.hasAnchor && !frozen.current) {
      const now = Date.now()
      const gap = now - lastFixTime.current
      if (gap > 100 && gap < 15000) {
        const before = kf.getState()
        if (before && before.speed > STATIONARY_SPEED) {
          kf.predictTo(now)
          const st = kf.getState()
          if (st) {
            const prev = lastPublish.current
            const moved = prev ? haversineF(prev, st) : 99
            // 0.3m altı render yapma (marker interpolasyonu aradaki kareleri doldurur)
            if (moved > 0.3) {
              const h = before.heading ?? st.heading
              publish({ lat: st.lat, lng: st.lng, heading: h, speed: before.speed, accuracy: 12, predicted: true, timestamp: now })
            }
          }
        }
      }
    }
    animFrameId.current = requestAnimationFrame(updatePrediction)
  }, [publish])

  const requestLocation = useCallback(() => {
    if (!navigator.geolocation) {
      setError('Tarayıcınız konum servisini desteklemiyor')
      setPermission('denied')
      return
    }
    setLoading(true)
    setError(null)
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        feedGps(pos.coords.latitude, pos.coords.longitude, pos.coords.heading, pos.coords.speed, pos.coords.accuracy, pos.timestamp || Date.now())
        setError(null)
      },
      (err) => {
        setLoading(false)
        switch (err.code) {
          case err.PERMISSION_DENIED:
            setPermission('denied')
            setError('Konum erişimi reddedildi.')
            break
          case err.POSITION_UNAVAILABLE:
            setError('Konum bilgisi alınamıyor.')
            break
          case err.TIMEOUT:
            setError('Konum alımı zaman aşımına uğradı.')
            break
          default:
            setError('Konum alınamadı.')
        }
      },
      { enableHighAccuracy: true, timeout: 30000, maximumAge: 1000 }
    )
  }, [feedGps])

  const restartWatch = useCallback(() => {
    try {
      if (watchId.current !== null && navigator.geolocation) {
        navigator.geolocation.clearWatch(watchId.current)
        watchId.current = null
      }
    } catch {}
    if (!navigator.geolocation) return
    watchId.current = navigator.geolocation.watchPosition(
      (pos) => {
        feedGps(pos.coords.latitude, pos.coords.longitude, pos.coords.heading, pos.coords.speed, pos.coords.accuracy, pos.timestamp || Date.now())
      },
      (err) => {
        setLoading(false)
        if (err.code === err.PERMISSION_DENIED) setPermission('denied')
      },
      { enableHighAccuracy: true, timeout: 30000, maximumAge: 1000 }
    )
  }, [feedGps])

  const startWatching = useCallback(() => {
    if (!navigator.geolocation) return
    if (watchId.current !== null) return
    setError(null)
    setPermission('granted')
    setLoading(true)
    if (!kalman.current) kalman.current = new PositionKalman()
    lastFixTime.current = 0
    frozen.current = null
    wasMoving.current = false

    watchId.current = navigator.geolocation.watchPosition(
      (pos) => {
        feedGps(pos.coords.latitude, pos.coords.longitude, pos.coords.heading, pos.coords.speed, pos.coords.accuracy, pos.timestamp || Date.now())
      },
      (err) => {
        setLoading(false)
        if (err.code === err.PERMISSION_DENIED) setPermission('denied')
      },
      { enableHighAccuracy: true, timeout: 30000, maximumAge: 1000 }
    )

    // Periyodik fallback (watch takılırsa)
    fallbackIntervalId.current = setInterval(() => {
      if (!navigator.geolocation) return
      // Durağan kilitteyken pili yorma
      if (frozen.current) return
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          feedGps(pos.coords.latitude, pos.coords.longitude, pos.coords.heading, pos.coords.speed, pos.coords.accuracy, pos.timestamp || Date.now())
        },
        () => {},
        { enableHighAccuracy: true, timeout: 15000, maximumAge: 2000 }
      )
    }, FALLBACK_INTERVAL)

    // GPS watchdog: 12sn fix yoksa + sekme görünürse watch'ı yeniden başlat
    if (watchdogIntervalId.current) clearInterval(watchdogIntervalId.current)
    watchdogIntervalId.current = setInterval(() => {
      if (watchId.current === null) return
      if (document.hidden) return
      if (Date.now() - lastFixTime.current > WATCHDOG_MS) {
        restartWatch()
        // Anlık tazele
        try {
          navigator.geolocation.getCurrentPosition(
            (pos) => feedGps(pos.coords.latitude, pos.coords.longitude, pos.coords.heading, pos.coords.speed, pos.coords.accuracy, pos.timestamp || Date.now()),
            () => {},
            { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
          )
        } catch {}
      }
    }, 4000)

    if (animFrameId.current === null) {
      animFrameId.current = requestAnimationFrame(updatePrediction)
    }
    // Ekran kilidi (navigasyonda ekran kapanmasın) — destek yoksa sessiz geç
    try {
      if (navigator.wakeLock?.request) {
        navigator.wakeLock.request('screen').then((l) => { wakeLock.current = l }).catch(() => {})
      }
    } catch {}
  }, [feedGps, restartWatch, updatePrediction])

  const stopWatching = useCallback(() => {
    if (watchId.current !== null) {
      try { navigator.geolocation.clearWatch(watchId.current) } catch {}
      watchId.current = null
    }
    if (animFrameId.current !== null) {
      cancelAnimationFrame(animFrameId.current)
      animFrameId.current = null
    }
    if (fallbackIntervalId.current !== null) {
      clearInterval(fallbackIntervalId.current)
      fallbackIntervalId.current = null
    }
    if (watchdogIntervalId.current !== null) {
      clearInterval(watchdogIntervalId.current)
      watchdogIntervalId.current = null
    }
    try { wakeLock.current?.release?.() } catch {}
    wakeLock.current = null
  }, [])

  const clearLocation = useCallback(() => {
    stopWatching()
    setLocation(null)
    setError(null)
    setPermission('prompt')
    if (kalman.current) kalman.current.reset()
    speedKf.current = null
    frozen.current = null
    lastFixTime.current = 0
    lastPublish.current = null
    wasMoving.current = false
  }, [stopWatching])

  // İvmeölçer kilidi (best-effort, izin yoksa hız mantığı yeterli)
  useEffect(() => {
    const onMotion = (e) => {
      const a = e.accelerationIncludingGravity || e.acceleration
      if (!a || a.x == null) return
      const mag = Math.hypot(a.x, a.y ?? 0, a.z ?? 0)
      const now = Date.now()
      const prev = accelRef.current
      const dm = Math.abs(mag - (prev.lastMag || mag))
      const dt = now - (prev.lastT || now)
      prev.lastMag = mag
      prev.lastT = now
      prev.active = true
      // 0.25 m/s² altı sarsıntı = durağan
      if (dm < 0.25 && dt < 500) {
        prev.stillMs += dt
      } else {
        prev.stillMs = 0
      }
    }
    try {
      window.addEventListener('devicemotion', onMotion, { passive: true })
    } catch {}
    return () => {
      try { window.removeEventListener('devicemotion', onMotion) } catch {}
    }
  }, [])

  // Sekme öne gelince watchdog benzeri toparlanma
  useEffect(() => {
    const onVis = () => {
      if (!document.hidden && watchId.current !== null && Date.now() - lastFixTime.current > 10000) {
        restartWatch()
      }
    }
    document.addEventListener('visibilitychange', onVis)
    return () => document.removeEventListener('visibilitychange', onVis)
  }, [restartWatch])

  useEffect(() => {
    return () => { stopWatching() }
  }, [stopWatching])

  return { location, loading, error, permission, requestLocation, startWatching, stopWatching, clearLocation }
}
