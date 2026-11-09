import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { customFetch } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { AlertTriangle, ArrowLeftRight, CheckCircle2, Loader2, Search } from "lucide-react";
import { useDebounce } from "@/hooks/use-debounce";

// Ett paket som skannas men som är AVRAPPORTERAT (utlevererat/hyvlat på en
// order) men ändå står kvar i lagret. Vanligaste orsaken: ordern skrevs med
// paket A, men ett annat paket B plockades (A stod längst in) utan att ordern
// ändrades. Dialogen låter användaren peka ut paketet B som plockades i
// stället, och rättar sedan order + lager i ett steg.

export type AvrapporteratPaket = {
  pktNr: string;
  metod: "skanner" | "manuell" | "kamera";
  avrapportering: {
    datumUt: string | null;
    avrappTyp: string | null;
    spec: { id: number; typ: string; etikett: string; kund: string | null; orderNr: string | null } | null;
    kanByta: boolean;
    kanAterinforas: boolean;
  };
  package: {
    traslag: string | null;
    profil: string | null;
    kvalitet: string | null;
    nomTjocklek: string | null;
    nomBredd: string | null;
    langder: number[];
    styck: number;
    nomM3: number;
  };
};

type Kandidat = {
  pktNr: string;
  traslag: string | null;
  profil: string | null;
  kvalitet: string | null;
  nomTjocklek: number | null;
  nomBredd: number | null;
  langder: number[];
  totalAntal: number;
  totalM3: number;
  omradeNamn: string | null;
  fackKod: string | null;
  saknasIFacket: boolean;
  orsaker: string[];
};

type SokTraff = Pick<Kandidat, "pktNr" | "traslag" | "profil" | "kvalitet" | "nomTjocklek" | "nomBredd" | "langder" | "totalAntal" | "totalM3" | "omradeNamn" | "fackKod"> & {
  deregistrerad?: boolean;
  avrapporterad?: boolean;
};

interface Props {
  sessionId: string;
  paket: AvrapporteratPaket | null;
  arbetar: boolean;
  onByt: (ersattAvPktNr: string) => void;
  onAterinfor: () => void;
  onStang: () => void;
}

function beskriv(k: Pick<Kandidat, "traslag" | "profil" | "kvalitet" | "nomTjocklek" | "nomBredd" | "langder">) {
  const dim = k.nomTjocklek || k.nomBredd ? `${k.nomTjocklek ?? "-"}×${k.nomBredd ?? "-"}` : null;
  return [k.traslag, dim, k.langder.length ? `${k.langder.join("+")} dm` : null, k.profil, k.kvalitet]
    .filter(Boolean)
    .join(" · ");
}

export default function AvrapporteratPaketDialog({ sessionId, paket, arbetar, onByt, onAterinfor, onStang }: Props) {
  const [vald, setVald] = useState<string | null>(null);
  const [sokText, setSokText] = useState("");
  const debounced = useDebounce(sokText.trim(), 250);

  useEffect(() => {
    setVald(null);
    setSokText("");
  }, [paket?.pktNr]);

  const kanByta = paket?.avrapportering.kanByta ?? false;

  const { data: kandData, isLoading: kandLaddar } = useQuery<{ data: Kandidat[] }>({
    queryKey: ["/api/inventering/byte-kandidater", sessionId, paket?.pktNr],
    queryFn: () =>
      customFetch<{ data: Kandidat[] }>(
        `/api/inventering/${sessionId}/byte-kandidater?pktNr=${encodeURIComponent(paket!.pktNr)}`,
      ),
    enabled: !!paket && kanByta,
  });
  const { data: sokData, isFetching: sokLaddar } = useQuery<{ data: SokTraff[] }>({
    queryKey: ["/api/inventering/sok-paket", "byte", debounced],
    queryFn: () => customFetch<{ data: SokTraff[] }>(`/api/inventering/sok-paket?q=${encodeURIComponent(debounced)}`),
    enabled: !!paket && kanByta && debounced.length >= 2,
  });

  if (!paket) return null;
  const { avrapportering, package: p } = paket;
  const spec = avrapportering.spec;
  const kandidater = kandData?.data ?? [];
  const sokTraffar = (sokData?.data ?? []).filter((t) => t.pktNr !== paket.pktNr && !t.deregistrerad && !t.avrapporterad);
  const visaSok = debounced.length >= 2;
  const lista: (Kandidat | SokTraff)[] = visaSok ? sokTraffar : kandidater;

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !arbetar) onStang(); }}>
      <DialogContent className="max-w-lg max-h-[92vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <AlertTriangle className="h-5 w-5 text-amber-600 shrink-0" />
            Paket {paket.pktNr} är avrapporterat
          </DialogTitle>
          <DialogDescription>
            {spec
              ? <>Systemet tror att paketet lämnade lagret på <strong>{spec.etikett}</strong>
                  {avrapportering.datumUt ? ` (${avrapportering.datumUt})` : ""}
                  {spec.kund ? ` · ${spec.kund}` : ""}, men det står kvar här.</>
              : <>Systemet tror att paketet har lämnat lagret{avrapportering.datumUt ? ` (${avrapportering.datumUt})` : ""}, men det står kvar här.</>}
          </DialogDescription>
        </DialogHeader>

        <div className="rounded-md border bg-muted/30 p-3 text-sm">
          <div className="font-mono font-medium">{paket.pktNr}</div>
          <div className="text-muted-foreground">
            {beskriv({
              traslag: p.traslag,
              profil: p.profil,
              kvalitet: p.kvalitet,
              nomTjocklek: p.nomTjocklek ? Number(p.nomTjocklek) : null,
              nomBredd: p.nomBredd ? Number(p.nomBredd) : null,
              langder: p.langder,
            }) || "—"}
          </div>
          <div className="text-muted-foreground">{p.styck} st · {p.nomM3.toFixed(2)} m³</div>
        </div>

        {kanByta && (
          <div className="space-y-3">
            <p className="text-sm font-medium">
              Vilket paket plockade du i stället för {paket.pktNr}?
            </p>
            <p className="text-xs text-muted-foreground -mt-2">
              Välj det paket som egentligen gick till ordern. Ordern och lagret rättas då så att båda stämmer.
            </p>

            <div className="relative">
              <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
              <input
                value={sokText}
                onChange={(e) => setSokText(e.target.value)}
                placeholder="Sök annat paket (paketnr, mått, träslag…)"
                className="w-full rounded-md border bg-background pl-8 pr-3 py-2 text-sm outline-none focus:ring-2 focus:ring-[#2d5a27]/40"
                autoComplete="off"
              />
            </div>

            <div className="rounded-md border divide-y max-h-64 overflow-y-auto">
              {(kandLaddar || (visaSok && sokLaddar)) && (
                <div className="p-3 text-xs text-muted-foreground flex items-center gap-2">
                  <Loader2 className="h-3 w-3 animate-spin" /> Söker…
                </div>
              )}
              {!kandLaddar && !(visaSok && sokLaddar) && lista.length === 0 && (
                <div className="p-3 text-sm text-muted-foreground text-center">
                  {visaSok ? "Inga träffar" : "Inga liknande paket hittades — sök efter paketnumret ovan."}
                </div>
              )}
              {lista.map((k) => {
                const vaiktad = vald === k.pktNr;
                const kand = k as Kandidat;
                return (
                  <button
                    key={k.pktNr}
                    type="button"
                    onClick={() => setVald(vaiktad ? null : k.pktNr)}
                    disabled={arbetar}
                    className={cn(
                      "w-full text-left px-3 py-2.5 text-sm transition-colors flex items-start gap-3",
                      vaiktad ? "bg-green-50 ring-2 ring-inset ring-[#2d5a27]" : "hover:bg-muted/50",
                    )}
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                        <span className="font-mono font-medium">{k.pktNr}</span>
                        {kand.saknasIFacket && (
                          <Badge className="bg-red-100 text-red-800 border border-red-300">Saknas i facket</Badge>
                        )}
                        {(kand.orsaker ?? []).filter((o) => o !== "Saknas i facket").map((o) => (
                          <Badge key={o} variant="secondary" className="font-normal">{o}</Badge>
                        ))}
                      </div>
                      <div className="text-xs text-muted-foreground">{beskriv(k) || "—"}</div>
                      <div className="text-xs text-muted-foreground">
                        {k.totalAntal} st · {k.totalM3.toFixed(2)} m³
                        {k.omradeNamn ? ` · ${k.omradeNamn}${k.fackKod ? " · Fack " + k.fackKod : ""}` : ""}
                      </div>
                    </div>
                    {vaiktad && <CheckCircle2 className="h-5 w-5 text-[#2d5a27] shrink-0 mt-0.5" />}
                  </button>
                );
              })}
            </div>

            {vald && spec && (
              <div className="rounded-md border border-[#2d5a27]/30 bg-green-50/60 p-3 text-sm space-y-1">
                <div className="font-medium flex items-center gap-1.5"><ArrowLeftRight className="h-4 w-4" /> Det här händer:</div>
                <div><span className="font-mono">{paket.pktNr}</span> läggs tillbaka i lager och räknas som hittat.</div>
                <div><span className="font-mono">{vald}</span> avrapporteras och ersätter {paket.pktNr} på {spec.etikett}.</div>
              </div>
            )}
          </div>
        )}

        {avrapportering.kanAterinforas && (
          <p className="text-sm text-muted-foreground">
            Paketet sitter inte på någon order. Står det kvar i lagret kan du återinföra det — det läggs tillbaka i
            lager och räknas som hittat.
          </p>
        )}

        <DialogFooter className="gap-2 sm:gap-2 flex-col-reverse sm:flex-row">
          <Button variant="outline" onClick={onStang} disabled={arbetar}>Avbryt</Button>
          {kanByta && (
            <Button
              onClick={() => vald && onByt(vald)}
              disabled={!vald || arbetar}
              className="bg-[#2d5a27] hover:bg-[#224420] text-white"
            >
              {arbetar && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              {vald ? `Byt mot ${vald}` : "Välj paket att byta mot"}
            </Button>
          )}
          {avrapportering.kanAterinforas && (
            <Button onClick={onAterinfor} disabled={arbetar} className="bg-[#2d5a27] hover:bg-[#224420] text-white">
              {arbetar && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              Återinför i lager
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
