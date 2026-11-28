# herdr-mods

Herdr mods, one folder each. A mod is a panel for the Herdr app: JavaScript that draws with
gpui-kit and reads the app through the `herdr` module.

| Mod | What it does |
|---|---|
| [`session`](mods/session/) | A panel that reads the pi session in the tab beside it: the discussion as written, with pi's tool calls and thinking folded to one line each, and a filter bar that hides them. |

## Install a mod

Herdr reads `~/.config/herdr-app`. Copy the mod's folder there, then check it:

```sh
cp -R mods/session ~/.config/herdr-app/mods/
herdr-app check ~/.config/herdr-app/mods/session
```

The first time Herdr sees the folder it docks the panel where its `mod.json` says (`right`, 380 px).
To put it beside a terminal by hand instead:

```sh
herdr-app do pane.split --direction right --mod session
```

Each mod's `RECIPE.md` says what it draws, how it behaves, and what it needs.
