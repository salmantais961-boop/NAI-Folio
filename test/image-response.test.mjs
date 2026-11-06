import { test } from 'node:test';
import assert from 'node:assert/strict';
import { crc32, deflateRawSync } from 'node:zlib';
import { decodeImages, RemoteImageResponseError, summarizeImageResponse } from '../server/image-response.mjs';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jZ90AAAAASUVORK5CYII=', 'base64');
const base64 = png.toString('base64');
const dataUrl = 'data:image/png;base64,' + base64;
const json = value => Buffer.from(JSON.stringify(value));
const MiB = 1024 * 1024;

function archive(files, { declaredSize } = {}) {
  const entries = [], directory = [];
  let offset = 0;
  for (const [nameText, data] of files) {
    const name = Buffer.from(nameText), compressed = deflateRawSync(data), checksum = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50);
    local.writeUInt16LE(8, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(name.length, 26);
    const descriptor = Buffer.alloc(16);
    descriptor.writeUInt32LE(0x08074b50);
    descriptor.writeUInt32LE(checksum, 4);
    descriptor.writeUInt32LE(compressed.length, 8);
    descriptor.writeUInt32LE(data.length, 12);
    const entry = Buffer.concat([local, name, compressed, descriptor]);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50);
    central.writeUInt16LE(8, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(declaredSize ?? data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    entries.push(entry);
    directory.push(central, name);
    offset += entry.length;
  }
  const central = Buffer.concat(directory), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...entries, central, end]);
}

test('decodes native and relay image envelopes without relying on Content-Type', () => {
  const forms = [
    { images: [base64] }, { images: [dataUrl] }, { image: base64 },
    { images: [{ image: base64 }] }, { images: [{ base64 }] },
    { images: [{ b64_json: base64 }] }, { images: [{ dataUrl }] },
    { data: [{ b64_json: base64 }] }, { data: base64 },
    [base64], base64, dataUrl,
  ];
  for (const form of forms) assert.equal(decodeImages(json(form), 'application/json')[0].dataUrl, dataUrl);
  for (const bytes of [png, Buffer.from(base64), Buffer.from(dataUrl)])
    for (const type of ['', 'application/octet-stream', 'application/json; charset=utf-8'])
      assert.equal(decodeImages(bytes, type)[0].dataUrl, dataUrl);
  assert.equal(decodeImages(Buffer.from(' \n' + base64.slice(0, 30) + '\r\n' + base64.slice(30)), 'text/plain')[0].dataUrl, dataUrl);
  assert.equal(decodeImages(Buffer.from('\uFEFF' + JSON.stringify({ image: base64 })), 'application/json')[0].dataUrl, dataUrl);
});

test('keeps individual seeds and official index ordering across supported payload fields', () => {
  const result = decodeImages(json({ images: [
    { index: 2, seed: 92, b64_json: base64 },
    { index: 0, seed: 90, image: base64 },
    { index: 1, seed: 91, dataUrl },
  ] }), 'application/json');
  assert.deepEqual(result.map(image => [image.name, image.seed]), [['image_0.png', 90], ['image_1.png', 91], ['image_2.png', 92]]);
  assert.equal(decodeImages(json({ image: base64, seed: 123 }))[0].seed, 123);
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
  const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 ')]);
  assert.equal(decodeImages(jpeg, 'application/json')[0].name, 'image_0.jpg');
  assert.equal(decodeImages(json({ images: [webp.toString('base64')] }))[0].name, 'image_0.webp');
});

test('decodes binary and base64 ZIPs, including native descriptor entries and wrapped archives', () => {
  const zip = archive([['../output.png', png], ['second.png', png]]), encoded = zip.toString('base64');
  for (const bytes of [zip, Buffer.from(encoded), json({ image: encoded }), json({ zip: encoded }), json({ data: encoded }), json({ images: [encoded] }), Buffer.from('data:application/zip;base64,' + encoded)]) {
    const result = decodeImages(bytes, 'application/json');
    assert.deepEqual(result.map(image => image.name), ['output.png', 'second.png']);
    assert(result.every(image => image.dataUrl === dataUrl));
  }
  const seeded = decodeImages(json({ image: encoded, seed: 4 }));
  assert.equal(seeded[0].seed, 4);
  assert.equal(seeded[1].seed, undefined, 'a wrapper seed must not be invented for every ZIP image');
  const corrupt = Buffer.from(zip);
  corrupt[zip.indexOf(Buffer.from('504b0102', 'hex')) + 16] ^= 0xff;
  assert.throws(() => decodeImages(corrupt));
});

test('identifies remote image responses without fetching URLs or losing batch order', () => {
  const url = 'https://cdn.example/image.png?private_token=secret';
  assert.throws(() => decodeImages(json({ data: [{ url, index: 1, seed: 19 }, { b64_json: base64, index: 0, seed: 18 }] })), error => {
    assert(error instanceof RemoteImageResponseError);
    assert.equal(error.code, 'REMOTE_IMAGE_URLS');
    assert.deepEqual(error.images.map(image => image.seed), [18, 19]);
    assert.equal(error.images[0].dataUrl, dataUrl);
    assert.equal(error.images[1].url, url);
    assert(!error.message.includes('secret'));
    assert(!error.message.includes('https://'));
    return true;
  });
});

test('rejects errors, HTML, unrelated nested fields and malformed base64 rather than treating them as images', () => {
  const invalid = [
    json({ error: { message: 'private upstream error' } }),
    json({ error: 'failed', images: [base64] }),
    json({ result: { unrelated: base64 } }),
    json({ images: [{ message: base64 }] }),
    json({ images: [] }), json({ image: '<html>not an image</html>' }),
    json({ image: base64 + '$' }), json({ image: 'a===' }),
    json({ image: 'data:text/html;base64,' + base64 }),
    json({ image: Buffer.from('{"message":"failure"}').toString('base64') }),
    Buffer.from('<!doctype html><html>private content</html>'),
    Buffer.from('{broken json'), Buffer.from('not an image'),
  ];
  for (const bytes of invalid) assert.throws(() => decodeImages(bytes, 'application/json'));
});

test('enforces image count and per-image limits for JSON, ZIPs and combined ZIP envelopes', () => {
  assert.throws(() => decodeImages(json({ images: Array(33).fill(base64) })));
  assert.throws(() => decodeImages(archive(Array.from({ length: 33 }, (_, i) => [`${i}.png`, png]))));
  const chunk = archive(Array.from({ length: 17 }, (_, i) => [`${i}.png`, png])).toString('base64');
  assert.throws(() => decodeImages(json({ images: [chunk, chunk] })));
  assert.throws(() => decodeImages(archive([['large.png', png]], { declaredSize: 48 * MiB + 1 })));
  const oversized = Buffer.alloc(48 * MiB + 1);
  png.copy(oversized);
  assert.throws(() => decodeImages(oversized, 'image/png'), /单张回图/);
});

test('enforces the total decoded limit across multiple compressed ZIP wrappers', () => {
  const large = Buffer.alloc(41 * MiB);
  png.copy(large);
  const encoded = archive([['large.png', large]]).toString('base64');
  assert.throws(() => decodeImages(json({ images: [encoded, encoded] })));
});

test('diagnostic summaries contain schema only, never prompt, key, response text or URL values', () => {
  const secret = 'never-include-this-private-value';
  const source = json({ images: [{ url: `https://cdn.example/${secret}?token=${secret}`, seed: 987654321 }], prompt: secret, api_key: secret, error: { message: secret }, [secret]: secret });
  const summary = summarizeImageResponse(source, 'application/json; private=' + secret);
  assert.equal(summary.contentType, 'application/json');
  assert.equal(summary.byteLength, source.length);
  assert.equal(summary.format, 'json');
  assert.equal(summary.shape.fields.images.type, 'array');
  const serialized = JSON.stringify(summary);
  assert(!serialized.includes(secret));
  assert(!serialized.includes('987654321'));
  assert(!serialized.includes('https://'));
  assert.equal(summary.shape.otherKeys, 1);
  assert.equal(summarizeImageResponse(Buffer.from('<html>' + secret), 'text/html').format, 'html');
  assert.equal(summarizeImageResponse(Buffer.from('<html>' + secret), 'application/json').format, 'html');
  assert.equal(summarizeImageResponse(Buffer.from('{"error":' + secret), 'application/json').format, 'invalid-json');
  assert.equal(summarizeImageResponse(png, 'application/json').format, 'image/png');
});
