# Third-party notices

PrintSheet's single-file build (`dist/index.html`) bundles the software and data below. Each keeps
its own licence. Full licence texts are in each package under `node_modules/` after `npm ci`, and
at the linked sources.

| Component | Use | Licence | Copyright | Source |
| --- | --- | --- | --- | --- |
| Fabric.js 7 | The editing canvas | MIT | 2008-2015 Printio (Juriy Zaytsev, Maxim Chernyak); 2016-present Andrea Bogazzi, Shachar Nen and Fabric.js contributors | https://github.com/fabricjs/fabric.js |
| pdf-lib 1.17 | Writing the PDF | MIT | 2019 Andrew Dillon | https://github.com/Hopding/pdf-lib |
| pako (inside pdf-lib) | PDF compression | MIT and Zlib | 2014-2017 Vitaly Puzrin and Andrei Tuputcyn | https://github.com/nodeca/pako |
| @pdf-lib/upng, @pdf-lib/standard-fonts | Parts of pdf-lib | MIT | 2017 Photopea; 2018 Andrew Dillon | https://github.com/Hopding/pdf-lib |
| tslib | Runtime helpers | 0BSD | Microsoft Corporation | https://github.com/microsoft/tslib |
| jsColorEngine 1.7 | RGB to CMYK conversion | MPL-2.0 | 2019, 2024 Glenn Wilton | https://github.com/glennwilton/jsColorEngine |
| jpeg-js 0.4 | JPEG colour in the compact PDF | BSD-3-Clause (text below) | 2014 Eugene Ware | https://github.com/jpeg-js/jpeg-js |
| idb-keyval 6 | Saving work in the browser | Apache-2.0 | Jake Archibald | https://github.com/jakearchibald/idb-keyval |
| Archivo (variable, Latin) | Interface typeface | SIL Open Font License 1.1 | 2020 The Archivo Project Authors | https://github.com/Omnibus-Type/Archivo |
| FOGRA39L_coated.icc | CMYK press profile | zlib (notice below) | see below | https://github.com/TeX-Live/colorprofiles |

## jsColorEngine (MPL-2.0)

jsColorEngine is used unmodified, as published on npm (`jscolorengine@1.7.1`). Its source code is
available at https://github.com/glennwilton/jsColorEngine and in the npm package. The MPL-2.0
licence text is at https://mozilla.org/MPL/2.0/.

## jpeg-js (BSD-3-Clause)

```
Copyright (c) 2014, Eugene Ware
All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright
   notice, this list of conditions and the following disclaimer.
2. Redistributions in binary form must reproduce the above copyright
   notice, this list of conditions and the following disclaimer in the
   documentation and/or other materials provided with the distribution.
3. Neither the name of Eugene Ware nor the names of its contributors
   may be used to endorse or promote products derived from this software
   without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY EUGENE WARE ''AS IS'' AND ANY
EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL EUGENE WARE BE LIABLE FOR ANY
DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES
(INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES;
LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND
ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
(INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS
SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```

## FOGRA39L_coated.icc

The CMYK export converts colours with the FOGRA39 coated-offset profile from the colord project,
as packaged by TeX Live's `colorprofiles` (generated with `cd-create-profile`; the profile states
"This profile is free of known copyright restrictions"). Its notice, reproduced as required:

```
FOGRA39L_coated
Copyright:  Kai-Uwe Behrmann <www.behrmann.name>
            Marti Maria <www.littlecms.com>
            Photogamut <www.photogamut.org>
            Graeme Gill <www.argyllcms.com>
            ColorSolutions <www.basICColor.com>

The zlib/libpng License

This software is provided 'as-is', without any express or implied
warranty. In no event will the authors be held liable for any damages
arising from the use of this software.

Permission is granted to anyone to use this software for any purpose,
including commercial applications, and to alter it and redistribute it
freely, subject to the following restrictions:

  1. The origin of this software must not be misrepresented; you must not
  claim that you wrote the original software. If you use this software
  in a product, an acknowledgment in the product documentation would be
  appreciated but is not required.

  2. Altered source versions must be plainly marked as such, and must not be
  misrepresented as being the original software.

  3. This notice may not be removed or altered from any source
  distribution.
```
