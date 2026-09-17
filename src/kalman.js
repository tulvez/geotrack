// Tulvez Harita — Self-host Kalman (bağımlılık yok, vendor)
// 4-state sabit-hız modeli: [x, y, vx, vy] metre (yerel ENU, anchor referanslı)
// kalmanjs R/Q adlandırma tersliği burada yok: q=proses gürültüsü, r=ölçüm gürültüsü (accuracy^2)

const DEG_LAT_M = 111320

function lngDegToM(latDeg) {
  return DEG_LAT_M * Math.cos((latDeg * Math.PI) / 180)
}

class KAxis {
  constructor() {
    this.x = 0 // konum (m)
    this.v = 0 // hız (m/s)
    this.p00 = 1
    this.p01 = 0
    this.p10 = 0
    this.p11 = 1
    this.initialized = false
  }
  init(pos, vel, posVar, velVar) {
    this.x = pos
    this.v = vel
    this.p00 = posVar
    this.p01 = 0
    this.p10 = 0
    this.p11 = velVar
    this.initialized = true
  }
  predict(dt, q) {
    // x = x + v*dt ; P = F*P*F' + Q
    this.x += this.v * dt
    const p00 = this.p00 + dt * (this.p10 + this.p01) + dt * dt * this.p11 + q * dt * dt * dt / 3
    const p01 = this.p01 + dt * this.p11 + (q * dt * dt) / 2
    const p10 = this.p10 + dt * this.p11 + (q * dt * dt) / 2
    const p11 = this.p11 + q * dt
    this.p00 = p00
    this.p01 = p01
    this.p10 = p10
    this.p11 = p11
  }
  // returns { accepted:boolean, residual, S }
  update(z, r, gateSigma = 4, minGateM = 8) {
    const y = z - this.x
    const S = this.p00 + r
    // Innovation gate: 4-sigma + min 8m (sıçrama reddi)
    if (S > 1e-9) {
      const norm = (y * y) / S
      if (norm > gateSigma * gateSigma && Math.abs(y) > minGateM) {
        return { accepted: false, residual: y, S }
      }
    }
    const k0 = this.p00 / (S || 1e-9)
    const k1 = this.p10 / (S || 1e-9)
    this.x += k0 * y
    this.v += k1 * y
    const p00 = (1 - k0) * this.p00
    const p01 = (1 - k0) * this.p01
    const p10 = -k1 * this.p00 + this.p10
    const p11 = -k1 * this.p01 + this.p11
    this.p00 = p00
    this.p01 = p01
    this.p10 = p10
    this.p11 = p11
    return { accepted: true, residual: y, S }
  }
}

export class PositionKalman {
  constructor(opts = {}) {
    // Bisiklet/yaya: q düşük = pürüzsüz ama gecikmeli; q yüksek = çevik ama titrek
    this.q = opts.processNoise ?? 1.6
    this.minGateM = opts.minGateM ?? 8
    this.gateSigma = opts.gateSigma ?? 4
    this.latAxis = new KAxis()
    this.lngAxis = new KAxis()
    this.anchorLat = 0
    this.anchorLng = 0
    this.hasAnchor = false
    this.lastT = 0
  }
  reset() {
    this.latAxis = new KAxis()
    this.lngAxis = new KAxis()
    this.hasAnchor = false
    this.lastT = 0
  }
  // Hız tohumlama ile başlat (velocity seeding: ilk fix'te GPS hızı kullan)
  seed(lat, lng, accuracyM, speedMS, headingDeg, nowMs) {
    const acc = Math.max(3, accuracyM || 10)
    const posVar = acc * acc
    const velVar = 4
    this.anchorLat = lat
    this.anchorLng = lng
    this.hasAnchor = true
    let vx = 0
    let vy = 0
    if (speedMS != null && headingDeg != null && !isNaN(headingDeg) && speedMS > 0.5) {
      const hr = (headingDeg * Math.PI) / 180
      const vN = speedMS * Math.cos(hr)
      const vE = speedMS * Math.sin(hr)
      vx = vE
      vy = vN
    }
    this.latAxis.init(0, vy, posVar, velVar)
    this.lngAxis.init(0, vx, posVar, velVar)
    this.lastT = nowMs
    // Kovaryansı hız belirsizliğine göre şişir (breakout'ta hızlı tepki)
    this.latAxis.p11 = velVar + (speedMS ?? 0)
    this.lngAxis.p11 = velVar + (speedMS ?? 0)
  }
  toMeters(lat, lng) {
    const dLat = (lat - this.anchorLat) * DEG_LAT_M
    const dLng = (lng - this.anchorLng) * lngDegToM(this.anchorLat)
    return { x: dLng, y: dLat }
  }
  toLatLng(x, y) {
    return {
      lat: this.anchorLat + y / DEG_LAT_M,
      lng: this.anchorLng + x / lngDegToM(this.anchorLat),
    }
  }
  predictTo(nowMs) {
    if (!this.hasAnchor || !this.lastT) return
    let dt = (nowMs - this.lastT) / 1000
    if (dt <= 0) return
    // Uzun boşlukta kovaryansı şişir (gap recovery), konum tahminini 15sn ile sınırla
    if (dt > 15) dt = 15
    if (dt > 5) {
      this.latAxis.p00 += 25
      this.lngAxis.p00 += 25
    }
    this.latAxis.predict(Math.min(dt, 2), this.q)
    this.lngAxis.predict(Math.min(dt, 2), this.q)
    this.lastT = nowMs
  }
  // Ölçüm güncelle; reddedilirse false döner (tahminde kal)
  update(lat, lng, accuracyM, nowMs) {
    if (!this.hasAnchor) return false
    this.predictTo(nowMs)
    const { x, y } = this.toMeters(lat, lng)
    const acc = Math.max(3, accuracyM || 10)
    const r = acc * acc
    const ry = this.latAxis.update(y, r, this.gateSigma, this.minGateM)
    const rx = this.lngAxis.update(x, r, this.gateSigma, this.minGateM)
    // Tek eksen reddedilirse tamamını reddet (tutarlılık)
    if (!ry.accepted || !rx.accepted) return false
    this.lastT = nowMs
    return true
  }
  getState() {
    if (!this.hasAnchor) return null
    const { lat, lng } = this.toLatLng(this.lngAxis.x, this.latAxis.x)
    const vx = this.lngAxis.x ? this.lngAxis.v : 0
    const vy = this.latAxis.x != null ? this.latAxis.v : 0
    const speed = Math.hypot(vx, vy)
    let heading = null
    if (speed > 0.4) {
      heading = ((Math.atan2(vx, vy) * 180) / Math.PI + 360) % 360
    }
    return { lat, lng, vx, vy, speed, heading }
  }
  // Breakout: duruştan harekete geçişte kovaryansı şişir (1sn gecikmeyi önler)
  boost() {
    this.latAxis.p11 += 6
    this.lngAxis.p11 += 6
    this.latAxis.p00 += 9
    this.lngAxis.p00 += 9
  }
}
