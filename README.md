# Colordle Visualiser

A browser extension that adds a panel to [Colordle](colordle.ryantanen.com) 
showing all your guesses as colored spheres floating inside a rotatable & zoomable 
3D RGB cube (axes = Red, Green, Blue, each 0–255).

## Installation

1. Download and unzip this project
2. Open `chrome://extensions`
3. Turn on **Developer mode** (top-right toggle).
4. Click **Load unpacked** and select the `colordle-3d` folder.
5. Go to [colordle](https://colordle.ryantanen.com/) (reload the page if it was already open)

You should see a small **"3D Guesses"** pill button in the bottom-right corner.

## Usage

1. Click **3D Guesses** to open the panel.
2. Click **🎯 Pick guess swatches**, then click on any *one* of the colored
   guess boxes/tiles in the game (any past guess already on screen).
   The extension learns what that element looks like and will automatically
   pick up every guess you make from then on, including ones added later.
3. Play normally — each new guess appears as a new sphere in the cube.
4. Drag inside the cube to rotate; scroll (or pinch on trackpad/touch) to zoom.
5. Use the color list at the bottom to see exact RGB values or remove a
   mistaken entry; **Clear** wipes everything for a fresh game.
6. If auto-detection ever misses a color (e.g. the site changes its markup),
   type an RGB triple like `168,60,94` or a hex code like `#a83c5e` into the
   manual box and hit **Add**.

Your captured guesses are saved locally per day, so refreshing the page keeps
your points. The "swatch" pattern you picked is remembered too, so you only
need to do the picking step once per browser install.

## Notes

- Everything runs locally in your browser — no data leaves your machine.
- This only activates on colordle.ryantanen.com, no other websites.
- The 3D view is a small hand-rolled canvas renderer (no external libraries),
  so it loads instantly and works offline.
