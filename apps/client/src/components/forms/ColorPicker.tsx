import { cn } from "cn";
import { Button } from "@/components/ui/button";

export type ColorSwatch = { value: string; label: string };

// Curated for the warm organic theme (see the org-accent and org-neutral tokens in
// index.css) and picked to stay legible against both the light cream background and
// the dark brown background.
export const COLOR_SWATCHES: ColorSwatch[] = [
  { value: "#c67139", label: "Terracotta" },
  { value: "#e8a070", label: "Peach" },
  { value: "#8c491a", label: "Clay" },
  { value: "#b5563c", label: "Rust" },
  { value: "#c9a227", label: "Ochre" },
  { value: "#7a8a5e", label: "Sage" },
  { value: "#a8c472", label: "Moss" },
  { value: "#485528", label: "Fern" },
  { value: "#4f7a8c", label: "Slate blue" },
  { value: "#7d5ba6", label: "Plum" },
  { value: "#a89d8d", label: "Taupe" },
  { value: "#645c50", label: "Umber" },
];

const DEFAULT_CUSTOM_COLOR = "#c67139";

function isSameColor(a: string | null | undefined, b: string): boolean {
  return (a ?? "").toLowerCase() === b.toLowerCase();
}

export function ColorPicker({
  value,
  onChange,
  idPrefix,
}: {
  value: string | null;
  onChange: (color: string | null) => void;
  idPrefix: string;
}) {
  const customInputValue = value && /^#[0-9a-fA-F]{6}$/.test(value) ? value : DEFAULT_CUSTOM_COLOR;

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2" role="group" aria-label="Preset colors">
        {COLOR_SWATCHES.map((swatch) => {
          const selected = isSameColor(value, swatch.value);
          return (
            <button
              key={swatch.value}
              type="button"
              aria-label={swatch.label}
              aria-pressed={selected}
              title={swatch.label}
              onClick={() => onChange(swatch.value)}
              className={cn(
                "h-7 w-7 rounded-full border-2 transition-all outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
                selected ? "border-foreground ring-2 ring-ring ring-offset-2 ring-offset-background" : "border-border hover:border-foreground/50",
              )}
              style={{ backgroundColor: swatch.value }}
            />
          );
        })}
      </div>
      <div className="flex items-center gap-2">
        <label htmlFor={`${idPrefix}-color-custom`} className="text-xs text-muted-foreground">
          Custom
        </label>
        <input
          id={`${idPrefix}-color-custom`}
          type="color"
          aria-label="Custom color"
          value={customInputValue}
          onChange={(e) => onChange(e.target.value)}
          className="h-7 w-10 cursor-pointer rounded border border-border bg-transparent p-0"
        />
        <code className="text-xs text-muted-foreground">{value ?? "No color"}</code>
        {value && (
          <Button type="button" variant="ghost" size="xs" onClick={() => onChange(null)}>
            Clear
          </Button>
        )}
      </div>
    </div>
  );
}
