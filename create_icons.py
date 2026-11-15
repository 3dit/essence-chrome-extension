# Generates the Essence "E" icons: a white bold E on a grey circle.
# Usage: python create_icons.py   (requires Pillow)
#
# The E is drawn as rectangles on a 16-unit grid, so at 16/32/128/256 px every
# edge lands exactly on a pixel boundary and the letter stays crisp even in the
# 16px toolbar icon. Only the circle edge is anti-aliased.
from PIL import Image, ImageDraw

SIZES = [16, 32, 128, 256]
BG = (82, 82, 82, 255)
FG = (255, 255, 255, 255)
SUPERSAMPLE = 8

# E geometry in 16-unit grid coordinates: (x0, y0, x1, y1)
E_RECTS = [
    (5, 3, 7, 13),    # spine
    (5, 3, 11, 5),    # top bar
    (5, 7, 10, 9),    # middle bar
    (5, 11, 11, 13),  # bottom bar
]

for size in SIZES:
    big = size * SUPERSAMPLE
    unit = big / 16
    img = Image.new('RGBA', (big, big), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    draw.ellipse((0, 0, big - 1, big - 1), fill=BG)
    for x0, y0, x1, y1 in E_RECTS:
        draw.rectangle((x0 * unit, y0 * unit, x1 * unit - 1, y1 * unit - 1), fill=FG)
    img.resize((size, size), Image.BOX).save(f'icons/Icon{size}.png')

print('Icons written to icons/Icon{16,32,128,256}.png')
