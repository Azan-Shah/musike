import assert from "node:assert/strict";
import { test } from "node:test";
import "fake-indexeddb/auto";
import { offlineEnabled, offlineSettings, readOfflineAudio, readOfflineLibrary, saveOfflineLibrary, saveOfflineHistory, purgeOfflineOwner } from "../../web/src/lib/offlineStore.ts";

test("version-one audio survives the additive metadata upgrade; snapshots require opt-in and purge by owner", async () => {
  const owner = crypto.randomUUID(); const other = crypto.randomUUID();
  const track = { id: "00000000001", title: "Saved", artist: "Fixture", duration: 12, thumb: "", art: "", kind: "song" as const };
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("musike-offline", 1);
    request.onupgradeneeded = () => {
      for (const name of ["audio", "blobs", "pins"]) {
        const store = request.result.createObjectStore(name, { keyPath: ["owner", "id"] }); store.createIndex("owner", "owner");
        if (name === "audio") store.createIndex("recent", ["owner", "played"]);
      }
      request.result.createObjectStore("settings", { keyPath: "owner" });
    };
    request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
  });
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(["audio", "blobs", "settings"], "readwrite");
    tx.objectStore("audio").put({ owner, id: track.id, track, bytes: 5, played: 1 });
    tx.objectStore("blobs").put({ owner, id: track.id, blob: new Blob(["saved"], { type: "audio/mp4" }) });
    tx.objectStore("settings").put({ owner, enabled: true, eligible: true, name: "Fixture", budget: 512 * 1024 * 1024 });
    tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error);
  }); db.close();
  const library = { favorites: [track], history: [track], playlists: [{ id: "fixture-list", name: "Full library", createdAt: 1, updatedAt: 1, tracks: [track, { ...track, id: "00000000002", title: "Not downloaded" }] }] };
  try {
    assert.equal(await (await readOfflineAudio(owner, track.id))!.text(), "saved");
    await saveOfflineLibrary(owner, library); assert.deepEqual(await readOfflineLibrary(owner), library);
    await saveOfflineLibrary(other, library); assert.equal(await readOfflineLibrary(other), null);
    await offlineSettings(other, { enabled: true }); await saveOfflineLibrary(other, library);
    await purgeOfflineOwner(owner);
    assert.equal(await readOfflineLibrary(owner), null); assert.equal(await readOfflineAudio(owner, track.id), null);
    assert.deepEqual(await readOfflineLibrary(other), library);
    await assert.rejects(saveOfflineLibrary(other, { ...library, favorites: [{ ...track, title: "x".repeat(9 * 1024 * 1024) }] }));
    assert.deepEqual(await readOfflineLibrary(other), library, "failed snapshot admission must retain the previous complete metadata");
  } finally { await purgeOfflineOwner(owner); await purgeOfflineOwner(other); }
});

test("offline history updates preserve full collection tracks and respect owner opt-in and deletion", async () => {
  const owner = crypto.randomUUID();
  const track = { id: "00000000001", title: "Saved", artist: "Fixture", duration: 12, thumb: "", art: "", kind: "song" as const };
  const other = { ...track, id: "00000000002" };
  const library = { favorites: [track], history: [], playlists: [{ id: "offline-mix", name: "Mix", createdAt: 1, updatedAt: 1, tracks: [track, other] }] };
  try {
    assert.equal(await offlineEnabled(owner), false);
    await saveOfflineHistory(owner, [track]);
    assert.equal(await readOfflineLibrary(owner), null);
    await offlineSettings(owner, { enabled: true, deleted: [track.id] });
    assert.equal(await offlineEnabled(owner), true);
    await saveOfflineLibrary(owner, library);
    await saveOfflineHistory(owner, [track, other]);
    assert.deepEqual(await readOfflineLibrary(owner), { ...library, history: [other] });
    await purgeOfflineOwner(owner);
    await saveOfflineHistory(owner, [other]);
    assert.equal(await readOfflineLibrary(owner), null);
  } finally { await purgeOfflineOwner(owner); }
});
