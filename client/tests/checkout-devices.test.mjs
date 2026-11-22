import assert from "node:assert/strict";
import { test } from "node:test";
import { createCameraSession } from "../src/shared/cameraSession.ts";
import { addressSuggestion, preciseLocation, validCoordinates, watchAccurateLocation, fetchDeliveryAddress } from "../src/shared/deliveryLocation.ts";

test("GPS address lookup uses the measured coordinates and returns a street address", async () => {
  const controller = new AbortController();
  const result = await fetchDeliveryAddress({ latitude: 47.92, longitude: 106.92 }, controller.signal, async (url, options) => {
    assert.equal(url.searchParams.get("lat"), "47.92");
    assert.equal(url.searchParams.get("lon"), "106.92");
    assert.equal(options.signal, controller.signal);
    return new Response(JSON.stringify({ lat: "47.92", lon: "106.92", address: {
      road: "Энхтайваны өргөн чөлөө", house_number: "12", city: "Улаанбаатар",
    } }));
  });
  assert.equal(result.label, "Энхтайваны өргөн чөлөө 12, Улаанбаатар");
});

test("a locality name alone cannot fill the detailed delivery address", () => {
  assert.equal(addressSuggestion({ lat: "47.92", lon: "106.92", address: {
    suburb: "Цайз", city: "Улаанбаатар",
  } }, { latitude: 47.92, longitude: 106.92 }), null);
});

test("address provider errors stay errors instead of inventing an address", async () => {
  await assert.rejects(fetchDeliveryAddress({ latitude: 47.92, longitude: 106.92 }, new AbortController().signal,
    async () => new Response("Unavailable", { status: 503 })));
});

function deviceFix(latitude, accuracy, timestamp = Date.now()) {
  return { timestamp, coords: { latitude, longitude: 106.92, accuracy } };
}

function gpsHarness(extra = {}) {
  let success;
  let failure;
  let options;
  const cleared = [];
  const updates = [];
  const completed = [];
  const errors = [];
  const stop = watchAccurateLocation({
    geolocation: {
      watchPosition(onSuccess, onFailure, value) { success = onSuccess; failure = onFailure; options = value; return 17; },
      clearWatch(id) { cleared.push(id); },
    },
    onPosition: (value) => updates.push(value),
    onComplete: (value) => completed.push(value),
    onError: (value) => errors.push(value),
    ...extra,
  });
  return { success, failure, options, cleared, updates, completed, errors, stop };
}

test("GPS requests fresh high-accuracy readings and improves a coarse fix", () => {
  const gps = gpsHarness();
  assert.equal(gps.options.maximumAge, 0);
  assert.equal(gps.options.enableHighAccuracy, true);
  gps.success(deviceFix(47.9, 5000));
  gps.success(deviceFix(47.91, 250));
  gps.success(deviceFix(47.92, 12));
  assert.equal(gps.completed[0].latitude, 47.92);
  assert.equal(gps.completed[0].accuracy, 12);
  assert.deepEqual(gps.cleared, [17]);
});

test("GPS rejects stale and invalid fixes instead of showing an old location", () => {
  const gps = gpsHarness();
  gps.success(deviceFix(47.9, 10, Date.now() - 60000));
  gps.success(deviceFix(NaN, 10));
  gps.success(deviceFix(47.9, -1));
  assert.equal(gps.updates.length, 0);
  gps.stop();
});

test("a worse reading never replaces the best GPS measurement", async () => {
  const gps = gpsHarness({ durationMs: 10 });
  gps.success(deviceFix(47.91, 80));
  gps.success(deviceFix(47.95, 2000));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(gps.updates.length, 1);
  assert.equal(gps.completed[0].latitude, 47.91);
});

test("cancelled GPS acquisition ignores late device callbacks", () => {
  const gps = gpsHarness();
  gps.stop();
  gps.success(deviceFix(47.92, 10));
  assert.equal(gps.updates.length, 0);
  assert.equal(gps.completed.length, 0);
});

test("permission denied stops the watch and reports an explicit error", () => {
  const gps = gpsHarness();
  gps.failure({ code: 1, message: "Denied" });
  assert.deepEqual(gps.cleared, [17]);
  assert.equal(gps.errors[0].code, 1);
});

test("no fresh device measurement produces an error, never a fallback coordinate", async () => {
  const gps = gpsHarness({ durationMs: 10 });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(gps.completed.length, 0);
  assert.equal(gps.errors[0].code, 3);
});

function fakeCamera(getStream) {
  const state = { active: false, error: "" };
  const track = { stopped: false, onended: null, stop() { this.stopped = true; } };
  const stream = { getTracks: () => [track], getVideoTracks: () => [track] };
  const session = createCameraSession({
    getStream: getStream ?? (async () => stream),
    onActive: (value) => { state.active = value; },
    onError: (value) => { state.error = value; },
  });
  const video = () => ({ srcObject: null, playCount: 0, async play() { this.playCount++; } });
  return { session, state, stream, track, video };
}

test("camera attaches after the retake video element mounts", async () => {
  const camera = fakeCamera();
  await camera.session.start();
  const video = camera.video();
  camera.session.attach(video);
  assert.equal(video.srcObject, camera.stream);
  assert.equal(video.playCount, 1);
  assert.equal(camera.state.active, true);
  camera.session.stop();
});

test("replacing the video node reattaches the running camera without stopping it", async () => {
  const camera = fakeCamera();
  const oldVideo = camera.video();
  camera.session.attach(oldVideo);
  await camera.session.start();
  camera.session.attach(null);
  const nextVideo = camera.video();
  camera.session.attach(nextVideo);
  assert.equal(oldVideo.srcObject, null);
  assert.equal(nextVideo.srcObject, camera.stream);
  assert.equal(camera.track.stopped, false);
  camera.session.stop();
});

test("closing the wizard while permission is pending releases the late stream", async () => {
  let resolveStream;
  const camera = fakeCamera(() => new Promise((resolve) => { resolveStream = resolve; }));
  const started = camera.session.start();
  camera.session.stop();
  resolveStream(camera.stream);
  await started;
  assert.equal(camera.track.stopped, true);
  assert.equal(camera.state.active, false);
});

test("camera disconnection enables retry and reports the interruption", async () => {
  const camera = fakeCamera();
  await camera.session.start();
  camera.track.onended();
  assert.equal(camera.state.active, false);
  assert.match(camera.state.error, /тасарлаа/);
});

test("playback rejection stops the stream instead of leaving a blank active preview", async () => {
  const camera = fakeCamera();
  camera.session.attach({ srcObject: null, play: async () => { throw new Error("play failed"); } });
  await camera.session.start();
  assert.equal(camera.state.active, false);
  assert.equal(camera.track.stopped, true);
  assert.match(camera.state.error, /тоглосонгүй/);
});

test("coarse or invalid device fixes are not treated as precise GPS", () => {
  assert.equal(preciseLocation({ latitude: 47.92, longitude: 106.92, accuracy: 3000 }), false);
  assert.equal(preciseLocation({ latitude: 47.92, longitude: 106.92 }), false);
  assert.equal(preciseLocation({ latitude: 47.92, longitude: 106.92, accuracy: 15 }), true);
  assert.equal(validCoordinates({ latitude: NaN, longitude: 106.92 }), false);
  assert.equal(validCoordinates({ latitude: 91, longitude: 106.92 }), false);
});

test("a reverse result for a distant similarly named place is discarded", () => {
  assert.equal(addressSuggestion({ lat: "47.95", lon: "106.98", address: { road: "Wrong road" } }, {
    latitude: 47.92, longitude: 106.92,
  }), null);
});

test("nearby address suggestions keep house number and region without inventing a city", () => {
  const suggestion = addressSuggestion({
    lat: "49.47", lon: "105.98", name: "Unrelated shop",
    address: { house_number: "12", road: "Төв зам", city: "Дархан" },
  }, { latitude: 49.47, longitude: 105.98 });
  assert.equal(suggestion.label, "Төв зам 12, Дархан");
  assert.equal(suggestion.label.includes("Unrelated shop"), false);
  assert.equal(suggestion.label.includes("Ulaanbaatar"), false);
});
