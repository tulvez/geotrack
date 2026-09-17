# API — @tulvez/gps-takip

**Sıfır bağımlılık garantisi:** `src/` altında `react` dışında hiçbir import
yoktur (doğrulandı). `react` yalnız `useUserLocation` hook'u içindir (peer).
Çekirdek (`kalman`, `ok`, `map3d`) saf JS'tir — React'sız da kullanılır.

## Kalman — `src/kalman.js`

```js
import { PositionKalman } from '@tulvez/gps-takip/kalman'
const kf = new PositionKalman()
kf.seed(lat, lng, accuracyM, speedMS, headingDeg, nowMs) // ilk fix
kf.update(lat, lng, accuracyM, nowMs)                    // → true | false (red)
const st = kf.getState()  // { lat, lng, vx, vy, speed, heading } | null
kf.boost()  // duruştan kalkışta kovaryansı şişir (gecikmeyi önler)
kf.reset()  // çapayı sıfırla
```

- 4-state sabit-hız modeli, metre, ENU, anchor referanslı.
- `update` reddedilirse (`false`) tahminde kalınır — sıçrama yok.
- Uzun boşlukta (>5sn) kovaryans şişer, tahmin 15sn ile sınırlanır.
- Hız `>0.4 m/s` altındayken `heading` null döner (duran pusula çöptür).

## Ok — `src/arrow.js`

```js
import { getRoadBearing, getSegmentBearing, computeArrowRotation,
  computeArrowTilt, angleDiff, lerpAngle, clampTurnRate } from '@tulvez/gps-takip/ok'
```

| Fonksiyon | İmza | Not |
|---|---|---|
| `getRoadBearing` | `(geometry, t) → derece \| null` | ~60m pencere ortalaması; kavşakta 90° sıçratmaz |
| `getSegmentBearing` | `(geometry, t) → derece \| null` | Ham segment yönü (ok için) |
| `computeArrowRotation` | `(routeBearing, mapBearing) → derece` | Ok = yol yönü − kamera açısı |
| `computeArrowTilt` | `(show3D, navigating, mapPitch) → derece` | Manuel 3B eğim |
| `angleDiff` | `(from, to) → derece` | En kısa dönüş farkı |
| `lerpAngle` | `(current, target, t) → derece` | Açı interpolasyonu (360 sarımlı) |
| `clampTurnRate` | `(prev, target, maxDeg) → derece` | Dönüş hızı sınırlayıcı |

## Hook — `src/useUserLocation.js`

```jsx
import { useUserLocation } from '@tulvez/gps-takip'
```

GPS izleme + Kalman + watchdog (12sn sessizlikte toparlanma) + ivmeölçer
kilidi + 60fps ölü-hesap + warm-start. Eşikler: duruş `<0.8 m/s`, kalkış
`>1.2 m/s`, donma kilidi 6m.

## 3B — `src/map3d.js`

`add3dBuildings(map, show3D)`, `toggle3DState(map, show3D, setShowD)` +
sabitler `NAV_PITCH=55`, `DEFAULT_PITCH_3D=60`, `DEFAULT_PITCH_2D=0`.
`map` = maplibre/mapbox uyumlu harita nesnesi.
