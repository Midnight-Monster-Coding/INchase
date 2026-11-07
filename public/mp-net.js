/* =============================================================================
 * INchase multiplayer: mp-net.js   (WebRTC transport, no Firebase inside)
 *
 *   Two data channels between the two players:
 *     ctl  reliable + ordered       hello / start / dead / fin / rematch / ping / pong
 *     pos  unordered, no retransmit position snapshots (a late packet is useless)
 *
 *   ICE servers are tried by the browser in parallel (host -> STUN -> Metered TURN -> ExpressTURN).
 *   The SDP is exchanged ONCE through Firestore ("non-trickle"), so signaling costs 2 writes per match.
 *   makeOffer / makeAnswer wait until the candidates are gathered, but never longer than the caps below.
 * ========================================================================== */
import { hasTurn } from './mp-core.js';

const GATHER_MAX_MS = 5000;        // hard cap
const NO_SERVER_MS = 400;          // no ICE server configured: only host candidates will ever come
const QUIET_MS = 3000;             // servers configured but silent (blocked / slow): stop waiting this long after the first candidate
const AFTER_RELAY_MS = 700;        // a relay candidate exists: give the others a moment, then go
const AFTER_SRFLX_NO_TURN_MS = 600;
const AFTER_SRFLX_WAIT_RELAY_MS = 2500;   // TURN is configured but its candidate is slow: wait this long after STUN answered
const CONNECT_TIMEOUT_MS = 15000;
const DISCONNECT_GRACE_MS = 5000;

function waitForGathering(pc, turn, hasServers) {
  return new Promise((resolve) => {
    if (pc.iceGatheringState === 'complete') { resolve(); return; }
    const t0 = performance.now();
    let relayAt = 0, srflxAt = 0, firstAt = 0, done = false, iv = 0;
    const finish = () => {
      if (done) return;
      done = true;
      clearInterval(iv);
      pc.removeEventListener('icecandidate', onCand);
      pc.removeEventListener('icegatheringstatechange', onState);
      resolve();
    };
    const onCand = (e) => {
      if (!e.candidate) { finish(); return; }
      const now = performance.now();
      if (!firstAt) firstAt = now;
      if (e.candidate.type === 'relay' && !relayAt) relayAt = now;
      if (e.candidate.type === 'srflx' && !srflxAt) srflxAt = now;
    };
    const onState = () => { if (pc.iceGatheringState === 'complete') finish(); };
    pc.addEventListener('icecandidate', onCand);
    pc.addEventListener('icegatheringstatechange', onState);
    iv = setInterval(() => {
      const n = performance.now();
      if (n - t0 > GATHER_MAX_MS) finish();
      else if (firstAt && !hasServers && n - firstAt > NO_SERVER_MS) finish();
      else if (firstAt && !srflxAt && !relayAt && n - firstAt > QUIET_MS) finish();
      else if (relayAt && n - relayAt > AFTER_RELAY_MS) finish();
      else if (srflxAt && !turn && n - srflxAt > AFTER_SRFLX_NO_TURN_MS) finish();
      else if (srflxAt && turn && !relayAt && n - srflxAt > AFTER_SRFLX_WAIT_RELAY_MS) finish();
    }, 100);
  });
}

export class Peer {
  /**
   * @param {object} o
   * @param {RTCIceServer[]} o.iceServers
   * @param {'all'|'relay'} [o.policy]
   * @param {(msg:object)=>void} o.onCtl
   * @param {(s:string)=>void} o.onPos
   * @param {()=>void} o.onOpen
   * @param {(why:string)=>void} o.onClose
   */
  constructor(o) {
    this.o = o;
    this.turn = hasTurn(o.iceServers || []);
    this.hasServers = !!(o.iceServers && o.iceServers.length);
    this.pc = new RTCPeerConnection({
      iceServers: o.iceServers || [],
      iceTransportPolicy: o.policy === 'relay' ? 'relay' : 'all',
      bundlePolicy: 'max-bundle'
    });
    this.ctl = null;
    this.pos = null;
    this.opened = false;
    this.closed = false;
    this._connTimer = 0;
    this._discTimer = 0;
    const pc = this.pc;
    pc.addEventListener('connectionstatechange', () => {
      const s = pc.connectionState;
      if (s === 'failed') this._die('ice-failed');
      else if (s === 'disconnected') {
        clearTimeout(this._discTimer);
        this._discTimer = setTimeout(() => { if (pc.connectionState === 'disconnected') this._die('disconnected'); }, DISCONNECT_GRACE_MS);
      } else if (s === 'connected') clearTimeout(this._discTimer);
    });
    pc.addEventListener('datachannel', (e) => this._wire(e.channel));
  }

  _wire(ch) {
    if (ch.label === 'ctl') this.ctl = ch;
    else if (ch.label === 'pos') this.pos = ch;
    else return;
    if (ch.label === 'pos') ch.binaryType = 'arraybuffer';
    ch.addEventListener('open', () => this._maybeOpen());
    ch.addEventListener('close', () => this._die('channel-closed'));
    ch.addEventListener('message', (e) => {
      if (this.closed || typeof e.data !== 'string') return;
      if (ch.label === 'ctl') {
        if (e.data.length > 4000) return;
        let m = null;
        try { m = JSON.parse(e.data); } catch (err) { return; }
        if (m && typeof m === 'object' && typeof m.k === 'string') this.o.onCtl(m);
      } else this.o.onPos(e.data);
    });
    this._maybeOpen();
  }

  _maybeOpen() {
    if (this.opened || this.closed) return;
    if (this.ctl && this.pos && this.ctl.readyState === 'open' && this.pos.readyState === 'open') {
      this.opened = true;
      clearTimeout(this._connTimer);
      this.o.onOpen();
    }
  }

  _armConnectTimer() {
    clearTimeout(this._connTimer);
    this._connTimer = setTimeout(() => { if (!this.opened) this._die('timeout'); }, CONNECT_TIMEOUT_MS);
  }

  _die(why) {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this._connTimer);
    clearTimeout(this._discTimer);
    try { this.o.onClose(why); } catch (e) { /* ignore */ }
    this._teardown();
  }

  _teardown() {
    try { if (this.ctl) this.ctl.close(); } catch (e) { /* ignore */ }
    try { if (this.pos) this.pos.close(); } catch (e) { /* ignore */ }
    try { this.pc.close(); } catch (e) { /* ignore */ }
  }

  /** Host: create the data channels and return the offer SDP (candidates included). */
  async makeOffer() {
    this._wire(this.pc.createDataChannel('ctl', { ordered: true }));
    this._wire(this.pc.createDataChannel('pos', { ordered: false, maxRetransmits: 0 }));
    await this.pc.setLocalDescription(await this.pc.createOffer());
    await waitForGathering(this.pc, this.turn, this.hasServers);
    return this.pc.localDescription.sdp;
  }

  /** Guest: take the host's offer, return the answer SDP (candidates included). */
  async makeAnswer(offerSdp) {
    await this.pc.setRemoteDescription({ type: 'offer', sdp: offerSdp });
    await this.pc.setLocalDescription(await this.pc.createAnswer());
    await waitForGathering(this.pc, this.turn, this.hasServers);
    this._armConnectTimer();
    return this.pc.localDescription.sdp;
  }

  /** Host: take the guest's answer. */
  async setAnswer(answerSdp) {
    await this.pc.setRemoteDescription({ type: 'answer', sdp: answerSdp });
    this._armConnectTimer();
  }

  send(msg) {
    if (this.closed || !this.ctl || this.ctl.readyState !== 'open') return false;
    try { this.ctl.send(JSON.stringify(msg)); return true; } catch (e) { return false; }
  }
  sendPos(str) {
    if (this.closed || !this.pos || this.pos.readyState !== 'open' || this.pos.bufferedAmount > 4096) return false;
    try { this.pos.send(str); return true; } catch (e) { return false; }
  }

  /** 'host' | 'srflx' | 'relay' | 'unknown': which route the connection ended up using (for the UI + your own logging) */
  async route() {
    try {
      const stats = await this.pc.getStats();
      let pairId = null;
      stats.forEach((r) => { if (r.type === 'transport' && r.selectedCandidatePairId) pairId = r.selectedCandidatePairId; });
      let pair = pairId ? stats.get(pairId) : null;
      if (!pair) stats.forEach((r) => { if (r.type === 'candidate-pair' && r.nominated && r.state === 'succeeded') pair = r; });
      if (!pair) return 'unknown';
      const loc = stats.get(pair.localCandidateId), rem = stats.get(pair.remoteCandidateId);
      const t = (loc && loc.candidateType) === 'relay' || (rem && rem.candidateType) === 'relay' ? 'relay' : ((loc && loc.candidateType) || 'unknown');
      return t === 'prflx' ? 'srflx' : t;
    } catch (e) { return 'unknown'; }
  }

  close() { if (!this.closed) { this.closed = true; clearTimeout(this._connTimer); clearTimeout(this._discTimer); this._teardown(); } }
}