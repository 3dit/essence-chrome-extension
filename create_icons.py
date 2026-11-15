# This script generates circular white PNG icons for Chrome extensions.
# Sizes: 128x128, 32x32, 16x16
from PIL import Image, ImageDraw

sizes = [256]
for size in sizes:
    img = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    # Draw a white circle centered in the square
    draw.ellipse((size*0.05, size*0.05, size*0.95, size*0.95), fill='white')
    img.save(f'icons/Icon{size}.png')
print('PNG icons created in icons/')
