Anything on a grid: the days of a month, the cells of a sheet.

`.bb-cells` lays out `--cols` columns of `--cell` squares with `--gap`. A `.bb-cell` is a tile with tabular numerals. `--mark` is a marked day (the hue, `on-hue` numerals), `--soft` a lighter one (tint, `-ink` numerals), `--head` the weekday letters, `--sheet` a spreadsheet cell (radius 4, `surface-sunken`). Today is a 2px ring in the hue, never a fill, so it can sit on a marked day.
