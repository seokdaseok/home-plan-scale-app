# Plan/Scale — Floor Plan Furniture Designer

A lightweight, single-page floor plan and furniture layout tool. No install, no build step, no server required — it's three plain files (HTML/CSS/JS) that run entirely in your browser.

## How to run it

1. Unzip the folder.
2. Double-click `index.html` to open it in your browser (Chrome, Edge, or Firefox all work well).

That's it. Everything runs locally — nothing is uploaded anywhere, and your project data never leaves your machine.

> **Note on saving images:** uploaded floor plan images are embedded directly into your saved `.json` project file, so it stays a single portable file you can move between computers.

## How to use it

### 1. Upload your floor plan (optional)
Click **Upload Floor Plan** in the top bar to bring in an image of your floor plan as a tracing reference. It'll appear semi-transparent on the canvas.

### 2. Set the scale
Click **Set Scale**, then click two points on the canvas that span a distance you know in real life — e.g. the two ends of a wall. Enter that real-world distance (in meters or feet) and confirm. Every room and furniture item is now measured accurately against this scale. If you don't upload an image, you can skip this — rooms and furniture are still measured in real meters, just drawn at a default reference scale.

### 3. Add rooms
- Click **Draw Room** in the canvas toolbar, then click-drag on the canvas to draw a room at its real size.
- Or click the **+** button next to "Rooms" in the left sidebar to add one with default dimensions, then resize it.
- Select a room (click it) to rename it and fine-tune its exact width, length, and position in the **Inspector** panel on the right.
- Drag the bottom-right corner of a selected room to resize it.

### 4. Build your furniture catalog
In the left sidebar, under **Furniture Catalog**:
- Type a name (e.g. "Bed"), pick a **shape** (Rectangle, Circle, Triangle, or L-Shape), enter the dimensions, pick a color, and click **Add to Catalog**.
- Repeat for every item you need (desk, sofa, wardrobe, round table, L-shaped sectional, etc).

**Shape dimensions:**
- **Rectangle** — width × length.
- **Circle** — a single diameter value (e.g. a round table).
- **Triangle** — width × length, forming a right triangle within that box.
- **L-Shape** — width × length define the full bounding box; the "notch" is the rectangular corner cut out of the top-right (handy for sectional sofas or L-shaped rooms/desks). The notch must be smaller than the full box.

You can also change an already-placed item's shape later from the **Inspector** panel on the right.

### 5. Place furniture
Drag any item from the **Furniture Catalog** list straight onto the canvas. You can place the same catalog item multiple times (e.g. two nightstands).

- **Move**: click and drag a placed item.
- **Rotate**: select it and click **Rotate 90°**, drag its small top handle for free rotation, or press `Q`.
- **Duplicate**: select it and click **Duplicate**, or press `D`.
- **Delete**: select it and click **Delete**, or press `Delete`/`Backspace`.
- Fine-tune exact position, size, rotation, and color in the **Inspector** panel.

### 6. Export your finished plan
Click **Export PDF** in the top bar. You'll get a landscape PDF with:
- The full furnished floor plan, drawn to scale with a 1-meter reference ruler.
- A **Rooms** list with each room's exact dimensions and area.
- A **Furniture Legend** color-coded to match the plan, with item counts (e.g. "Chair ×4").

### Saving your work
Your layout isn't auto-saved. Use **Save File** in the top bar to download a `.json` project file any time, and **Load File** to pick up where you left off later. The PDF export is a final snapshot for sharing/printing — the project file is what you reopen to keep editing.

## Tips

- **Snap** (on by default) rounds positions and sizes to the nearest 10cm, which keeps things tidy. Toggle it off in the canvas toolbar if you need finer control.
- **Grid** shows 1-meter gridlines — toggle it off for a cleaner look while placing items.
- Use **Ctrl/Cmd + scroll** over the canvas to zoom in and out.
- Keyboard shortcuts: `V` select tool, `R` draw-room tool, `Q` rotate, `D` duplicate, `Delete` remove, `Esc` deselect.

## Files

```
floorplan-designer/
├── index.html   — page structure
├── style.css    — visual styling (blueprint/drafting theme)
├── app.js       — all application logic (state, canvas rendering, interactions, PDF export)
└── README.md    — this file
```

No dependencies to install. The only external libraries are loaded from a CDN at runtime for PDF export (jsPDF) and fonts (Google Fonts) — both require an internet connection the first time you export a PDF or load the page with custom fonts. The core editor (drawing rooms, placing furniture) works fully offline.
