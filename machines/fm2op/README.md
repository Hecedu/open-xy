# 2op FM

A small fixed-point phase-modulation synth with shared C++ sound and orbit
animation. Read [engine.cpp](engine.cpp), [core.h](core.h) and
[display.cpp](display.cpp) alongside the [engine API](../../docs/api.md).

| Control | Mapping |
| --- | --- |
| Ratio | Continuous modulator/carrier ratio, 0.5..16; interpolated anchors in `definition.json` |
| Amount | `8 * value^2` radians of carrier phase modulation |
| Feedback | `1.5 * value^2` radians, using two previous modulator samples |
| Decay | `20 * 200^value` ms to 1/e brightness |

Feedback does not decay; Decay scales the modulator's influence on the carrier.
The carrier plays at one eighth of full scale (`FM2_OUTPUT_LEVEL`), so a stock
volume readout sounds about as loud as on stock instruments and Macro Osc.
Controls smooth per voice. The display responds to note starts and controls;
it is not an audio scope.

```sh
python sdk.py preview --engine fm2op --out local/fm2op-preview-001
python tools/serve_harness.py --preview local/fm2op-preview-001
python sdk.py check
```

`definition.json` owns controls, defaults and the display shape, `tables.h` and
`orbit.hpp` hold lookup data, and `machine.json` declares the kind and identity. Shared adapters and host runners live in the SDK.

See [native builds](../../docs/build.md) to put it on the device.

Run `python sdk.py test --machine machines/fm2op` for machine checks and CPU screening.
Native `compile` / `build` output adds compiled loop packet counts, not device
cycles. Follow the [CPU review method](../../docs/api.md#cpu) before setting a
polyphony target; include every internal voice and release tail.
