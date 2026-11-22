import assert from "node:assert/strict";
import { test } from "node:test";
import { createCameraSession } from "../src/shared/cameraSession.ts";
import { addressSuggestion, preciseLocation, validCoordinates } from "../src/shared/deliveryLocation.ts";

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
