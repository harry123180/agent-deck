# Generates assets/icon.ico and assets/icon.png: dark rounded square with 3 stacked "tabs" and a prompt chevron.
# Run from anywhere: python scripts/make_icon.py
import os
from PIL import Image, ImageDraw
ASSETS = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'assets')
S = 1024
im = Image.new('RGBA', (S, S), (0, 0, 0, 0))
d = ImageDraw.Draw(im)
d.rounded_rectangle((32, 32, S-32, S-32), radius=200, fill=(24, 28, 40, 255))
d.rounded_rectangle((32, 32, S-32, S-32), radius=200, outline=(110, 168, 254, 255), width=22)
for i, c in enumerate([(76, 195, 138), (240, 180, 41), (110, 168, 254)]):  # tab strip: running / attention / active
    x = 150 + i * 250
    d.rounded_rectangle((x, 150, x + 220, 215), radius=26, fill=c)
d.line([(250, 400), (460, 560), (250, 720)], fill=(215, 218, 224, 255), width=70, joint='curve')
d.rounded_rectangle((520, 690, 780, 745), radius=27, fill=(110, 168, 254, 255))
im.save(os.path.join(ASSETS, 'icon.png'))
im.save(os.path.join(ASSETS, 'icon.ico'), sizes=[(256,256),(128,128),(64,64),(48,48),(32,32),(16,16)])
