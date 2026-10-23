import { IS_DEVNET } from "@/lib/config";

export function Banners() {
  return (
    <div className="text-center text-sm font-medium">
      {IS_DEVNET && <div className="bg-amber-300 px-3 py-1 text-amber-950">Devnet — test money only</div>}
      <div className="bg-stone-900 px-3 py-1 text-stone-100">Texas residents only</div>
    </div>
  );
}
