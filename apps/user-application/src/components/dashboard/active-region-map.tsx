import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Globe, ChevronDown } from "lucide-react";
import { useState, useMemo } from "react";
import countries from "world-countries";
import { useGeoClickStore } from "@/hooks/geo-clicks-store";
import { groupClicksByMile } from "@/lib/utils";
import { ClickMap } from "./click-map";

type Region = {
  id: string;
  name: string;
  projection: {
    scale: number;
    center: [number, number];
  };
};

const regions: Region[] = [
  {
    id: "Americas",
    name: "Americas",
    projection: { scale: 250, center: [-80, 0] },
  },
  {
    id: "Europe",
    name: "Europe",
    projection: { scale: 350, center: [30, 54] },
  },
  {
    id: "Africa",
    name: "Africa",
    projection: { scale: 400, center: [20, 0] },
  },
  {
    id: "Asia",
    name: "Asia",
    projection: { scale: 300, center: [100, 30] },
  },
  {
    id: "Oceania",
    name: "Oceania",
    projection: { scale: 500, center: [140, -25] },
  },
];

export function ActiveRegionMap() {
  const { clicks } = useGeoClickStore();

  // Create a map of country codes to regions
  const countryToRegion = useMemo(() => {
    const map = new Map<string, string>();
    countries.forEach((country) => {
      map.set(country.cca2, country.region);
    });
    return map;
  }, []);

  const [selectedRegion, setSelectedRegion] = useState<string>("Americas");

  const currentRegion =
    regions.find((r) => r.id === selectedRegion) || regions[0];

  // Filter clicks by selected region and group them
  const regionClicks = useMemo(() => {
    const filtered = clicks.filter((click) => {
      const region = countryToRegion.get(click.country);
      return region === selectedRegion;
    });
    return groupClicksByMile(filtered);
  }, [clicks, selectedRegion, countryToRegion]);

  return (
    <Card className="lg:col-span-1 hover:shadow-md transition-all duration-200 ">
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2">
            <Globe className="h-5 w-5" />
            {currentRegion.name}
          </CardTitle>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm">
                {currentRegion.name}
                <ChevronDown className="h-4 w-4 ml-1" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent>
              {regions.map((region) => (
                <DropdownMenuItem
                  key={region.id}
                  onClick={() => setSelectedRegion(region.id)}
                >
                  {region.name}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </CardHeader>
      <CardContent>
        <ClickMap
          clicks={regionClicks}
          scale={currentRegion.projection.scale}
          center={currentRegion.projection.center}
        />
      </CardContent>
    </Card>
  );
}
