`canyon-colors.json.gz` is the lossless RGB histogram of the Grand Canyon image supplied by the user on 2026-10-10. It tests the six requested paint groups against the actual antialiasing and compression shades, without storing the artwork itself.

`canyon-traced.json.gz` contains fill/path counts from that same image traced with vtracer color-cluster, cutout, spline, speckle 0, color precision 8, layer difference 16. The regression also checks the palette after near-identical cleanup.
