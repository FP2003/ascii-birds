# ascii birds

```
                              .;S;.
                              %@8#%
                              '8S8'
         .,;;:;:tt%%SSS%%%tt%SX88XS%tt%%%SSS%%tt:;:;;,.
    .';tt%S88##@@#8X%%t;;;:;tSX8@@8XSt;;:;;t%%X8#@@##88S%tt;'.
 '::%S8@@#S%t;:'.     ''::;tS8@##@8St;::''      .':;t%S#@@8S%::'
  ' ' ;'  ''               'tS8@@8St'               ''  '; ' '
                            :%S88S%:
                            ;tX88Xt;
                           ;tS%XX%St;
                          ;%t;'  ';t%;
                          '        '

        v  -  ^       v    -   v  ^     -  v
     ^   v   v  -  ^     v  ^    -   v
```

Small-bird flocks and the raptors that hunt them, drawn as ASCII on a canvas. Zero dependencies.

Forked from ascii sharks: the fish schools are now
flocks of starlings, swallows, sparrows, finches and pigeons, and the sharks are now raptors
seen from below. Raptors soar and glide between bursts of wingbeats, flap hard on the hunt,
and (the falcon especially) fold into a stoop on the final approach. Click to scare a flock.

```sh
npm install && npm run dev
```

```ts
import { SkyEngine } from "./src";

const engine = new SkyEngine(canvas, [{ kind: "eagle", size: 1 }]);
engine.setTheme("light"); // or "dark"
```

React:

```tsx
import { AsciiSky } from "./src/react";

<AsciiSky raptors={[{ kind: "falcon", size: 1 }]} theme="light" />
```

Raptors: `hawk`, `falcon`, `eagle`, `kite`, `osprey`, `owl`. The default sky mixes eagle, kite, hawk, owl and falcon at different sizes; try `?raptors=eagle,falcon,kite,owl` in the demo for your own lineup (the first is biggest, the rest step down). The demo has a light/dark toggle that remembers your choice.
