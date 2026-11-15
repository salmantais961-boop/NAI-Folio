"""Pack exact-size PNG renders of src-tauri/icons/icon.svg (no resampling).

Usage: python scripts/pack-icons.py <directory containing icon-16.png etc.>
PNG renders must be 8-bit, non-interlaced RGBA, e.g. Chromium SVG screenshots.
"""
import struct
import sys
import zlib
from pathlib import Path

SIZES = (16, 20, 24, 28, 32, 40, 48, 56, 64, 80, 96, 128, 256)


def rgba(png, size):
    at, compressed = 8, bytearray()
    while at < len(png):
        length = struct.unpack_from('>I', png, at)[0]
        kind, data = png[at + 4:at + 8], png[at + 8:at + 8 + length]
        if kind == b'IHDR':
            assert struct.unpack('>IIBBBBB', data) == (size, size, 8, 6, 0, 0, 0)
        if kind == b'IDAT':
            compressed.extend(data)
        at += length + 12
    raw, result = zlib.decompress(compressed), bytearray()
    stride = size * 4
    previous = bytearray(stride)
    for y in range(size):
        offset = y * (stride + 1)
        mode, row = raw[offset], bytearray(raw[offset + 1:offset + 1 + stride])
        for x in range(stride):
            a, b, c = row[x - 4] if x >= 4 else 0, previous[x], previous[x - 4] if x >= 4 else 0
            if mode == 4:
                p = a + b - c
                predictor = min((a, b, c), key=lambda v: abs(p - v))
            else:
                predictor = (0, a, b, (a + b) // 2)[mode]
            row[x] = (row[x] + predictor) & 255
        result.extend(row)
        previous = row
    return result


if __name__ == '__main__':
    source = Path(sys.argv[1])
    target = Path(__file__).resolve().parents[1] / 'src-tauri' / 'icons'
    images = [(n, (source / f'icon-{n}.png').read_bytes()) for n in SIZES]
    offset = 6 + 16 * len(images)
    directory = bytearray(struct.pack('<HHH', 0, 1, len(images)))
    for size, png in images:
        pixels = rgba(png, size)
        directory.extend(struct.pack('<BBBBHHII', size % 256, size % 256, 0, 0, 1, 32, len(png), offset))
        offset += len(png)
        if size <= 64:
            (target / f'tray-{size}.rgba').write_bytes(pixels)
    (target / 'icon.ico').write_bytes(directory + b''.join(png for _, png in images))
    print(f'Packed {len(images)} exact-size icon frames; tray rasters: 16–64 px.')
