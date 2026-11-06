#!/usr/bin/env python3
"""
Mahatachyons Flow Connector — Bottom-Right Watermark Inpainter
Uses simple-lama-inpainting if available, falling back to OpenCV Telea inpainting.
"""
import sys
from pathlib import Path


def inpaint_image(in_path: Path, out_path: Path) -> None:
    try:
        from PIL import Image
        import numpy as np
    except ImportError:
        raise RuntimeError("Install pillow and numpy (`pip install pillow numpy opencv-python`) to use inpaint mode.")

    img = Image.open(in_path).convert("RGB")
    w, h = img.size

    mask = Image.new("L", (w, h), 0)
    box_w = max(140, int(w * 0.14))
    box_h = max(44, int(h * 0.06))
    for y in range(h - box_h, h):
        for x in range(w - box_w, w):
            mask.putpixel((x, y), 255)

    try:
        from simple_lama_inpainting import SimpleLama
        lama = SimpleLama()
        result = lama(img, mask)
        result.save(out_path)
        return
    except ImportError:
        pass

    import cv2
    bgr = cv2.cvtColor(np.array(img), cv2.COLOR_RGB2BGR)
    mask_np = np.array(mask)
    cleaned = cv2.inpaint(bgr, mask_np, 5, cv2.INPAINT_TELEA)
    cv2.imwrite(str(out_path), cleaned)


def main() -> None:
    if len(sys.argv) < 3:
        print("Usage: inpaint.py <input> <output>", file=sys.stderr)
        sys.exit(1)
    in_path = Path(sys.argv[1]).resolve()
    out_path = Path(sys.argv[2]).resolve()
    inpaint_image(in_path, out_path)


if __name__ == "__main__":
    main()

