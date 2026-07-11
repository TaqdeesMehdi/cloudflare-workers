import { SidebarMenu, SidebarMenuItem } from "@/components/ui/sidebar";
import { ModeToggle } from "@/components/common/mode-toggle";
import { UserTab } from "@/components/auth/user-icon";

export function NavUser() {
  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <div className="flex items-center justify-between px-2 py-1">
          <ModeToggle />
        </div>
      </SidebarMenuItem>
      <SidebarMenuItem>
        <UserTab />
      </SidebarMenuItem>
    </SidebarMenu>
  );
}
