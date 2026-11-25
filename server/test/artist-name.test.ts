import assert from "node:assert/strict";
import { test } from "node:test";
import { cleanArtist } from "../src/artistName.js";
import { sanitizeTrack } from "../src/library.js";

test("auto-generated Topic channels show just the artist", () => {
  assert.equal(cleanArtist("Mugendai MewType - Topic"), "Mugendai MewType");
  assert.equal(cleanArtist("Mili - topic"), "Mili");
  assert.equal(cleanArtist("A - Topic, B"), "A, B");
  assert.equal(cleanArtist("Topic"), "Topic");
  assert.equal(cleanArtist("The Topic Band"), "The Topic Band");
  assert.equal(cleanArtist("Hot Topic - Live"), "Hot Topic - Live");
  assert.equal(sanitizeTrack({ id: "aaaaaaaaaaa", title: "KEEP ON", artist: "Mugendai MewType - Topic" }).artist, "Mugendai MewType");
});
