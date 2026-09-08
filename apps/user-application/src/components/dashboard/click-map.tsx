import { Button } from "@/components/ui/button";
import { Minus, Plus, RotateCcw } from "lucide-react";
import { useEffect, useState } from "react";
import {
  ComposableMap,
  Geographies,
  Geography,
  Marker,
  ZoomableGroup,
} from "react-simple-maps";
import type { GroupedGeoClick } from "@/lib/utils";

const GEOGRAPHY_URL =
  "https://cdn.jsdelivr.net/npm/world-atlas@2/countries-110m.json";

const MIN_ZOOM = 1;
const MAX_ZOOM = 64;
const ZOOM_STEP = 2;
// Zoom applied when a cluster is clicked, so a pin resolves to a street level view
const MARKER_FOCUS_ZOOM = 32;

type ClickMapProps = {
  clicks: GroupedGeoClick[];
  scale: number;
  center: [number, number];
};

export function ClickMap({ clicks, scale, center }: ClickMapProps) {
  const [longitude, latitude] = center;
  const [position, setPosition] = useState({
    coordinates: center,
    zoom: MIN_ZOOM,
  });

  // Snap back to the base view whenever the projection changes (e.g. new region)
  useEffect(() => {
    setPosition({ coordinates: [longitude, latitude], zoom: MIN_ZOOM });
  }, [longitude, latitude, scale]);

  const clamp = (zoom: number) => Math.min(Math.max(zoom, MIN_ZOOM), MAX_ZOOM);

  const zoomBy = (factor: number) =>
    setPosition((current) => ({
      ...current,
      zoom: clamp(current.zoom * factor),
    }));

  const resetView = () =>
    setPosition({ coordinates: [longitude, latitude], zoom: MIN_ZOOM });

  const focusOnClick = (group: GroupedGeoClick) =>
    setPosition({
      coordinates: [group.longitude, group.latitude],
      zoom: clamp(Math.max(position.zoom * 4, MARKER_FOCUS_ZOOM)),
    });

  // Markers live inside the zoomable group, so counter-scale them to keep a
  // constant on screen size no matter how far in the user has zoomed
  const zoom = position.zoom;

  return (
    <div className="h-96 bg-muted/30 rounded-lg border border-border relative overflow-hidden">
      <ComposableMap
        projection="geoMercator"
        projectionConfig={{ scale, center }}
        width={800}
        height={400}
        className="w-full h-full"
      >
        <ZoomableGroup
          center={position.coordinates}
          zoom={position.zoom}
          minZoom={MIN_ZOOM}
          maxZoom={MAX_ZOOM}
          onMoveEnd={({ coordinates, zoom }) =>
            setPosition({ coordinates, zoom })
          }
        >
          <Geographies geography={GEOGRAPHY_URL}>
            {({ geographies }) =>
              geographies.map((geo) => (
                <Geography
                  key={geo.rsmKey}
                  geography={geo}
                  fill="#d1d5db"
                  stroke="#9ca3af"
                  strokeWidth={0.2 / zoom}
                  style={{
                    default: { outline: "none" },
                    hover: { outline: "none" },
                    pressed: { outline: "none" },
                  }}
                />
              ))
            }
          </Geographies>
          {clicks.map((group, index) => {
            const baseRadius = Math.min(2 + group.count * 0.5, 8) / zoom;
            const maxRadius = Math.min(5 + group.count * 2, 50) / zoom;
            const secondMaxRadius = Math.min(4 + group.count * 1.5, 25) / zoom;

            return (
              <Marker
                key={index}
                coordinates={[group.longitude, group.latitude]}
                onClick={() => focusOnClick(group)}
                className="cursor-pointer"
              >
                <g>
                  <title>
                    {`${group.count} click${group.count === 1 ? "" : "s"} · ${group.latitude.toFixed(4)}, ${group.longitude.toFixed(4)}`}
                  </title>
                  <circle
                    r={maxRadius}
                    fill="none"
                    stroke="#ef4444"
                    strokeWidth={1 / zoom}
                    opacity="0"
                  >
                    <animate
                      attributeName="r"
                      from={baseRadius}
                      to={maxRadius}
                      dur="1.5s"
                      repeatCount="indefinite"
                    />
                    <animate
                      attributeName="opacity"
                      from="0.8"
                      to="0"
                      dur="1.5s"
                      repeatCount="indefinite"
                    />
                  </circle>
                  <circle
                    r={secondMaxRadius}
                    fill="none"
                    stroke="#ef4444"
                    strokeWidth={0.5 / zoom}
                    opacity="0"
                  >
                    <animate
                      attributeName="r"
                      from={baseRadius}
                      to={secondMaxRadius}
                      dur="1.5s"
                      begin="0.5s"
                      repeatCount="indefinite"
                    />
                    <animate
                      attributeName="opacity"
                      from="0.6"
                      to="0"
                      dur="1.5s"
                      begin="0.5s"
                      repeatCount="indefinite"
                    />
                  </circle>
                  <circle r={baseRadius} fill="#ef4444" />
                </g>
              </Marker>
            );
          })}
        </ZoomableGroup>
      </ComposableMap>

      {/* Zoom controls */}
      <div className="absolute top-2 right-2 flex flex-col gap-1">
        <Button
          variant="outline"
          size="icon"
          className="size-7 bg-background/80 backdrop-blur-sm"
          aria-label="Zoom in"
          disabled={zoom >= MAX_ZOOM}
          onClick={() => zoomBy(ZOOM_STEP)}
        >
          <Plus className="size-3.5" />
        </Button>
        <Button
          variant="outline"
          size="icon"
          className="size-7 bg-background/80 backdrop-blur-sm"
          aria-label="Zoom out"
          disabled={zoom <= MIN_ZOOM}
          onClick={() => zoomBy(1 / ZOOM_STEP)}
        >
          <Minus className="size-3.5" />
        </Button>
        <Button
          variant="outline"
          size="icon"
          className="size-7 bg-background/80 backdrop-blur-sm"
          aria-label="Reset view"
          disabled={zoom === MIN_ZOOM}
          onClick={resetView}
        >
          <RotateCcw className="size-3.5" />
        </Button>
      </div>

      {/* Zoom level */}
      {zoom > MIN_ZOOM && (
        <div className="absolute top-2 left-2 rounded-md bg-background/80 px-2 py-0.5 text-xs font-medium text-muted-foreground backdrop-blur-sm">
          {zoom < 10 ? zoom.toFixed(1) : Math.round(zoom)}x
        </div>
      )}

      {/* Legend */}
      <div className="absolute bottom-2 left-2 text-xs text-muted-foreground">
        <div className="flex items-center gap-1">
          <div className="w-2 h-2 rounded-full bg-red-500"></div>
          <span>Active Users</span>
        </div>
      </div>

      {/* Interaction hint */}
      <div className="absolute bottom-2 right-2 text-xs text-muted-foreground/80 text-right">
        Scroll to zoom · drag to pan · click a pin for its exact spot
      </div>
    </div>
  );
}
