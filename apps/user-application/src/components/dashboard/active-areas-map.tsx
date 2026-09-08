import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Globe } from "lucide-react";
import { useGeoClickStore } from "@/hooks/geo-clicks-store";
import { groupClicksByMile } from "@/lib/utils";
import { ClickMap } from "./click-map";

const WORLD_CENTER: [number, number] = [0, 20];

export function ActiveAreasMap() {
  const { clicks } = useGeoClickStore();

  const groupedClicks = groupClicksByMile(clicks);

  return (
    <Card className="lg:col-span-1 hover:shadow-md transition-all duration-200">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Globe className="h-5 w-5" />
          Active Areas
        </CardTitle>
      </CardHeader>
      <CardContent>
        <ClickMap clicks={groupedClicks} scale={100} center={WORLD_CENTER} />
      </CardContent>
    </Card>
  );
}
