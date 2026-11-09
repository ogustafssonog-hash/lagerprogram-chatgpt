import { useCallback, useEffect, useRef, useState } from "react";
import { useLocation, useRoute, useSearch } from "wouter";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { customFetch } from "@workspace/api-client-react";
import { useUser } from "@clerk/react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { useDebounce } from "@/hooks/use-debounce";
import { cn } from "@/lib/utils";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { ScanBarcode, Camera, CheckCircle2, AlertCircle, Loader2, ArrowLeft, Flag, X, ChevronDown, ChevronUp } from "lucide-react";
import { KLASS_LABEL, KLASS_COLOR, type SessionOversikt, type Klassificering } from "./types";
import KameraSkanner from "./KameraSkanner";
import AvrapporteratPaketDialog, { type AvrapporteratPaket } from "./AvrapporteratPaketDialog";
import { omradeskartaHref, sessionsHref } from "@/pages/lagerplatser/inventeringskarta";

type Feedback = { kind: "ok" | "warn" | "error"; text: string } | null;

// En träff i paketsökningen — grupperad per pktNr (GET /api/inventering/sok-paket).
// Ett fysiskt paket kan ligga som flera lager_poster-rader (en per längd);
// backend slår ihop dem till EN träff här, se lagerFilters.ts.
type PaketSokTraff = {
  pktNr: string;
  traslag: string | null;
  profil: string | null;
  kvalitet: string | null;
  nomTjocklek: number | null;
  nomBredd: number | null;
  langder: number[];
  antalRader: number;
  totalAntal: number;
  totalM3: number;
  omradeId: number | null;
  fackId: number | null;
  omradeNamn: string | null;
  fackKod: string | null;
  blandadPlacering: boolean;
  deregistrerad: boolean;
  avrapporterad?: boolean;
  kanAterstallas: boolean;
  restaureringsAnledning: string | null;
};

type DeregistreratPaket = {
  pktNr: string;
  kanAterstallas: boolean;
  restaureringsAnledning: string | null;
  metod: "skanner" | "manuell" | "kamera";
  package: {
    traslag: string | null;
    profil: string | null;
    kvalitet: string | null;
    nomTjocklek: string | null;
    nomBredd: string | null;
    langder: number[];
    styck: number;
    nomM3: number;
    blandadPlacering: boolean;
  };
};

function dimStr(t: number | null, b: number | null) {
  if (!t && !b) return null;
  return `${t ?? "-"}×${b ?? "-"}`;
}

export default function InventeringSkanningPage() {
  const { user } = useUser();
  const isAdmin = user?.publicMetadata?.role === "admin";
  const [, params] = useRoute("/inventering/skanna/:id");
  const id = params?.id;
  const searchString = useSearch();
  const searchParams = new URLSearchParams(searchString);
  const omgangId = Number(searchParams.get("omgangId")) || null;
  const kartOmrade = searchParams.get("kartOmrade") ?? undefined;
  const inventeringskartaHref = omgangId && kartOmrade ? omradeskartaHref(kartOmrade, omgangId) : null;
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const inputRef = useRef<HTMLInputElement>(null);
  const [inputValue, setInputValue] = useState("");
  const [metod, setMetod] = useState<"skanner" | "manuell" | "kamera">("skanner");
  const [scanning, setScanning] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [avslutar, setAvslutar] = useState(false);
  const [inputFocused, setInputFocused] = useState(false);
  const [kameraOppen, setKameraOppen] = useState(false);
  const [tarBortPktNr, setTarBortPktNr] = useState<string | null>(null);
  const [deregistreratPaket, setDeregistreratPaket] = useState<DeregistreratPaket | null>(null);
  const [aterstaller, setAterstaller] = useState(false);
  const [avrapporteratPaket, setAvrapporteratPaket] = useState<AvrapporteratPaket | null>(null);
  const [avrapporteratArbetar, setAvrapporteratArbetar] = useState(false);
  const [visaKvar, setVisaKvar] = useState(false);

  const { data: session, isLoading } = useQuery<SessionOversikt>({
    queryKey: ["/api/inventering", id],
    queryFn: () => customFetch<SessionOversikt>(`/api/inventering/${id}`),
    enabled: !!id,
  });

  useEffect(() => {
    inputRef.current?.focus();
  }, [session?.id]);

  const focusInput = useCallback(() => inputRef.current?.focus(), []);

  // Autocomplete för den manuella pktNr-sökningen — samma sök-/UX-mönster
  // som "Lägg till paket" i Specifikationer (debounce + dropdown), men mot
  // en egen backend-endpoint som grupperar träffar per fysiskt paket.
  const debouncedQuery = useDebounce(inputValue.trim(), 250);
  const skannadeSet = new Set(session?.skanningar.map((s) => s.pktNr) ?? []);
  const { data: sokData, isFetching: sokLaddar } = useQuery<{ data: PaketSokTraff[] }>({
    queryKey: ["/api/inventering/sok-paket", debouncedQuery],
    queryFn: () => customFetch<{ data: PaketSokTraff[] }>(`/api/inventering/sok-paket?q=${encodeURIComponent(debouncedQuery)}`),
    enabled: debouncedQuery.length >= 1 && metod !== "kamera",
  });
  const sokResultat = sokData?.data ?? [];
  const visaDropdown = inputFocused && metod !== "kamera" && inputValue.trim().length >= 1;

  async function handleScan(raw: string, metodOverride?: "skanner" | "manuell" | "kamera") {
    const pktNr = raw.trim();
    if (!pktNr || !id) return;
    setScanning(true);
    setFeedback(null);
    try {
      const valdMetod = metodOverride ?? metod;
      const result = await customFetch<
        | { redanSkannad: boolean; klassificering: Klassificering; session: SessionOversikt; deregistrerad?: false; avrapporterad?: false }
        | (Omit<DeregistreratPaket, "metod"> & { deregistrerad: true; avrapporterad?: false })
        | (Omit<AvrapporteratPaket, "metod"> & { avrapporterad: true; deregistrerad?: false })
      >(
        `/api/inventering/${id}/skanna`,
        { method: "POST", body: JSON.stringify({ pktNr, metod: valdMetod }) },
      );
      if (result.avrapporterad) {
        setAvrapporteratPaket({ ...result, metod: valdMetod });
        signalera("warn");
        setFeedback({
          kind: "warn",
          text: result.avrapportering.spec
            ? `${pktNr} är avrapporterat på ${result.avrapportering.spec.etikett} — välj vad som hänt`
            : `${pktNr} är avrapporterat men står kvar — välj vad som hänt`,
        });
        return;
      }
      if (result.deregistrerad) {
        signalera("warn");
        setDeregistreratPaket({ ...result, metod: valdMetod });
        setFeedback({
          kind: "warn",
          text: result.kanAterstallas
            ? `${pktNr} är avregistrerat och måste återinföras manuellt`
            : `${pktNr} är avregistrerat men kan inte återinföras säkert`,
        });
        return;
      }
      queryClient.setQueryData(["/api/inventering", id], result.session);
      if (result.redanSkannad) {
        signalera("warn");
        setFeedback({ kind: "warn", text: `${pktNr} redan skannat i denna inventering` });
      } else if (result.klassificering === "forvantad_hittad") {
        setFeedback({ kind: "ok", text: `${pktNr} — stämmer, hör hemma här` });
      } else {
        signalera("error");
        setFeedback({ kind: "error", text: `${pktNr} — ${KLASS_LABEL[result.klassificering]}` });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Okänt fel";
      signalera("error");
      setFeedback({ kind: "error", text: msg });
    } finally {
      setScanning(false);
      setInputValue("");
      setMetod((m) => (m === "kamera" ? "skanner" : m));
      focusInput();
    }
  }

  // Kort vibration på mobil så att man märker avvikelser utan att titta på skärmen.
  function signalera(typ: "warn" | "error") {
    try {
      navigator.vibrate?.(typ === "error" ? [120, 60, 120] : 120);
    } catch {
      /* vibration stöds inte — ignorera */
    }
  }

  // Ombyte på order: det avrapporterade paketet står kvar, ett annat paket
  // plockades i stället. Servern rättar order + lager i ett steg och skannar
  // in paketet.
  async function handleByt(ersattAvPktNr: string) {
    if (!id || !avrapporteratPaket) return;
    const kandidat = avrapporteratPaket;
    setAvrapporteratArbetar(true);
    try {
      const result = await customFetch<{ order: string; session: SessionOversikt }>(
        `/api/inventering/${id}/byt-paket`,
        {
          method: "POST",
          body: JSON.stringify({ pktNr: kandidat.pktNr, ersattAvPktNr, metod: kandidat.metod }),
        },
      );
      queryClient.setQueryData(["/api/inventering", id], result.session);
      queryClient.invalidateQueries({ queryKey: ["/api/inventering/sok-paket"] });
      setAvrapporteratPaket(null);
      setFeedback({ kind: "ok", text: `${kandidat.pktNr} hittat · ${ersattAvPktNr} ersätter det på ${result.order}` });
      toast({
        title: "Ordern rättad",
        description: `${kandidat.pktNr} är tillbaka i lager. ${ersattAvPktNr} ligger nu på ${result.order}.`,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Okänt fel";
      signalera("error");
      toast({ title: "Kunde inte byta paket", description: msg, variant: "destructive" });
    } finally {
      setAvrapporteratArbetar(false);
      focusInput();
    }
  }

  async function handleAterinforAvrapporterat() {
    if (!id || !avrapporteratPaket) return;
    const kandidat = avrapporteratPaket;
    setAvrapporteratArbetar(true);
    try {
      const result = await customFetch<{ session: SessionOversikt }>(`/api/inventering/${id}/aterinfor-avrapporterat`, {
        method: "POST",
        body: JSON.stringify({ pktNr: kandidat.pktNr, metod: kandidat.metod }),
      });
      queryClient.setQueryData(["/api/inventering", id], result.session);
      queryClient.invalidateQueries({ queryKey: ["/api/inventering/sok-paket"] });
      setAvrapporteratPaket(null);
      setFeedback({ kind: "ok", text: `${kandidat.pktNr} återinfört i lager och hittat` });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Okänt fel";
      signalera("error");
      toast({ title: "Kunde inte återinföra paketet", description: msg, variant: "destructive" });
    } finally {
      setAvrapporteratArbetar(false);
      focusInput();
    }
  }

  async function handleAterstall() {
    if (!id || !deregistreratPaket || !deregistreratPaket.kanAterstallas) return;
    const kandidat = deregistreratPaket;
    setAterstaller(true);
    try {
      await customFetch(`/api/inventering/${id}/aterstall`, {
        method: "POST",
        body: JSON.stringify({ pktNr: kandidat.pktNr }),
      });
      setDeregistreratPaket(null);
      queryClient.invalidateQueries({ queryKey: ["/api/inventering/sok-paket"] });
      await handleScan(kandidat.pktNr, kandidat.metod);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Okänt fel";
      setFeedback({ kind: "error", text: msg });
    } finally {
      setAterstaller(false);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") handleScan(inputValue);
    if (e.key === "Escape") { setInputValue(""); inputRef.current?.blur(); }
  }

  function valjSokTraff(p: PaketSokTraff) {
    handleScan(p.pktNr, "manuell");
  }

  // Ångrar en enskild skanning (t.ex. felskanning). Tar bort HELA
  // pktNr-skanningen som en enhet — även paket med flera längdrader.
  // Rör aldrig lager_poster/område/fack/plats; enbart en "ångra
  // inventeringsskanning". Servern räknar om Hittade/Kvar/Felplacerade/
  // Okända/Otydliga live, så det räcker att ersätta sessionen i cachen.
  async function handleTaBortSkanning(pktNr: string) {
    if (!id) return;
    setTarBortPktNr(pktNr);
    try {
      const result = await customFetch<{ borttagen: boolean; session: SessionOversikt }>(
        `/api/inventering/${id}/skanna/${encodeURIComponent(pktNr)}`,
        { method: "DELETE" },
      );
      queryClient.setQueryData(["/api/inventering", id], result.session);
      toast({ title: `${pktNr} borttaget från inventeringen` });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Okänt fel";
      toast({ title: "Kunde inte ta bort skanningen", description: msg, variant: "destructive" });
    } finally {
      setTarBortPktNr(null);
    }
  }

  // Kamerans streckkodsläsning (multi-format, verifierad mot systemet) och
  // AI-fotofallback landar båda här med ett verifierat pktNr — precis som
  // fysisk handscanner och manuell sökning körs det sedan genom EXAKT
  // samma handleScan()/POST-skanna, så resultat och klassificering blir
  // identiska oavsett källa.
  function handlePktNrFranKamera(pktNr: string) {
    setKameraOppen(false);
    handleScan(pktNr, "kamera");
  }

  // Kameran kunde läsa en kod men INTE entydigt matcha den mot ett paket i
  // systemet (olika sågverk kodar sina lappar olika — se KameraSkanner.tsx).
  // Vi gissar aldrig: stäng kameran, förifyll den befintliga manuella
  // sökrutan med det avlästa värdet och låt operatören välja rätt paket i
  // autocomplete-dropdownen.
  function handleOklarKodFranKamera(raValde: string, kodTyp: string) {
    setKameraOppen(false);
    setMetod("manuell");
    setInputValue(raValde);
    setFeedback({ kind: "warn", text: `Oklar kod (${kodTyp}): "${raValde}" — välj rätt paket nedan` });
    focusInput();
  }

  async function avslutaInventering() {
    if (!id) return;
    setAvslutar(true);
    try {
      await customFetch(`/api/inventering/${id}/avsluta`, { method: "POST" });
      queryClient.invalidateQueries({ queryKey: ["/api/inventering"] });
      toast({ title: "Inventering avslutad" });
      setLocation(sessionsHref("resultat", Number(id), omgangId, kartOmrade));
    } catch {
      toast({ title: "Kunde inte avsluta inventeringen", variant: "destructive" });
      setAvslutar(false);
    }
  }

  if (isLoading || !session) {
    return (
      <div className="flex-1 flex items-center justify-center h-full">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const { raknare } = session;
  const kvarAttHitta = Math.max(0, raknare.forvantadeAntalPaket - raknare.hittade);

  return (
    // Negativa marginaler lever här, på den STATISKA (icke-sticky) roten —
    // inte på själva sticky-headern. En sticky-positionerad ruta med sin
    // egen negativa margin får sitt "fastnålat"-läge beräknat exklusive den
    // marginalen, vilket gör att den hoppar rakt in över innehållet med ett
    // mellanrum lika stort som marginalen så fort sidan scrollas ens en
    // pixel — det var den bakomliggande orsaken till att rubriken täckte de
    // första komponenterna. Genom att lägga marginalen på den statiska
    // roten och låta headern själv vara marginal-fri sticky, matchar dess
    // "still"-läge och "fastnålat"-läge exakt, utan hopp.
    <div className="flex flex-col h-full min-h-0 -mx-4 -mt-4 md:-mx-8 md:-mt-8" onClick={focusInput}>
      <div className="border-b px-4 md:px-8 py-4 flex items-center gap-3 bg-background sticky top-0 z-10 shrink-0">
        <Button variant="ghost" size="icon" onClick={(e) => { e.stopPropagation(); setLocation(inventeringskartaHref ?? "/inventering"); }}>
          <ArrowLeft className="h-5 w-5" />
        </Button>
        <div className="flex-1 min-w-0">
          <h1 className="text-lg font-semibold truncate">{session.omradeNamn} · Fack {session.fackKod}</h1>
          <p className="text-xs text-muted-foreground">Skanna paket i facket — ett skanningsbart streckkodsläge</p>
        </div>
        <Button
          onClick={(e) => { e.stopPropagation(); avslutaInventering(); }}
          disabled={avslutar}
          className="bg-[#2d5a27] hover:bg-[#224420] text-white shrink-0"
        >
          {avslutar ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Flag className="h-4 w-4 mr-2" />}
          Avsluta
        </Button>
      </div>

      <div className="flex flex-col gap-4 px-4 md:px-8 pt-4 pb-4 md:pb-8 flex-1 min-h-0 overflow-auto">
        <div className="flex flex-wrap gap-2">
          <Badge className="bg-blue-100 text-blue-800 border-blue-300 border">{raknare.hittade}/{raknare.forvantadeAntalPaket} hittade</Badge>
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); setVisaKvar((v) => !v); }}
            className="inline-flex items-center gap-1 rounded-md border px-2.5 py-0.5 text-xs font-semibold hover:bg-muted transition-colors"
            title="Visa vilka paket som ännu inte hittats"
          >
            {kvarAttHitta} kvar att hitta
            {kvarAttHitta > 0 && (visaKvar ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />)}
          </button>
          {raknare.felplacerade > 0 && <Badge className="bg-orange-100 text-orange-800 border-orange-300 border">{raknare.felplacerade} felplacerade</Badge>}
          {raknare.okanda > 0 && <Badge className="bg-red-100 text-red-800 border-red-300 border">{raknare.okanda} okända</Badge>}
          {raknare.otydliga > 0 && <Badge className="bg-yellow-100 text-yellow-800 border-yellow-300 border">{raknare.otydliga} otydliga</Badge>}
        </div>

        {visaKvar && session.saknadePaket.length > 0 && (
          <div className="rounded-lg border bg-muted/20" onClick={(e) => e.stopPropagation()}>
            <div className="px-4 py-2 text-xs font-medium text-muted-foreground border-b">
              Paket som systemet tror ligger i facket men som inte skannats ännu
            </div>
            <div className="divide-y max-h-60 overflow-y-auto">
              {session.saknadePaket.map((k) => (
                <div key={k.pktNr} className="px-4 py-2 text-sm flex items-baseline justify-between gap-3">
                  <span className="font-mono font-medium">{k.pktNr}</span>
                  <span className="text-xs text-muted-foreground text-right">
                    {[
                      k.traslag,
                      k.nomTjocklek || k.nomBredd ? `${k.nomTjocklek ?? "-"}×${k.nomBredd ?? "-"}` : null,
                      k.langder.length ? `${k.langder.join("+")} dm` : null,
                      `${k.totalAntal} st`,
                    ].filter(Boolean).join(" · ")}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        <div
          className={cn(
            "rounded-xl border-2 p-6 flex flex-col items-center gap-4 transition-colors cursor-text",
            feedback?.kind === "error" ? "border-destructive/50 bg-destructive/5" :
            feedback?.kind === "warn" ? "border-yellow-500/50 bg-yellow-50/50" :
            feedback?.kind === "ok" ? "border-green-500/50 bg-green-50/50" :
            "border-dashed border-muted-foreground/30 hover:border-muted-foreground/50"
          )}
          onClick={(e) => { e.stopPropagation(); inputRef.current?.focus(); }}
        >
          <div className="flex items-center gap-3 w-full max-w-md relative">
            <ScanBarcode className={cn("h-5 w-5 shrink-0", scanning ? "animate-pulse text-[#2d5a27]" : "text-muted-foreground")} />
            <input
              ref={inputRef}
              type="text"
              value={inputValue}
              onChange={(e) => { setInputValue(e.target.value); setFeedback(null); if (metod !== "kamera") setMetod("skanner"); }}
              onKeyDown={handleKeyDown}
              onFocus={() => setInputFocused(true)}
              onBlur={() => setInputFocused(false)}
              placeholder="Skanna eller skriv paket-ID…"
              className="flex-1 bg-transparent text-lg outline-none placeholder:text-muted-foreground/50 font-mono"
              autoComplete="off"
              autoCorrect="off"
              spellCheck={false}
            />
            {scanning && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); setKameraOppen(true); }}
              className="h-9 w-9 -mr-1 flex items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-muted transition-colors shrink-0"
              title="Skanna streckkod med mobilkameran"
            >
              <Camera className="h-5 w-5" />
            </button>

            {visaDropdown && (
              <div
                className="absolute left-8 right-0 top-full mt-1 z-20 rounded-lg border bg-popover shadow-md max-h-72 overflow-y-auto text-left"
                onClick={(e) => e.stopPropagation()}
                onMouseDown={(e) => e.preventDefault()}
              >
                {sokLaddar && (
                  <div className="p-3 text-xs text-muted-foreground flex items-center gap-2">
                    <Loader2 className="h-3 w-3 animate-spin" /> Söker…
                  </div>
                )}
                {!sokLaddar && sokResultat.length === 0 && (
                  <div className="p-3 text-sm text-muted-foreground text-center">Inga träffar på "{inputValue.trim()}"</div>
                )}
                {!sokLaddar && sokResultat.map((p) => {
                  const redanSkannad = skannadeSet.has(p.pktNr);
                  const dim = dimStr(p.nomTjocklek, p.nomBredd);
                  const plats = p.blandadPlacering
                    ? "Blandad placering"
                    : p.omradeNamn
                      ? `${p.omradeNamn}${p.fackKod ? " · Fack " + p.fackKod : ""}`
                      : "Inget fack angivet";
                  return (
                    <button
                      key={p.pktNr}
                      type="button"
                      onClick={() => valjSokTraff(p)}
                      className="w-full flex items-center justify-between gap-3 px-3 py-2 border-b last:border-b-0 hover:bg-muted/50 transition-colors text-sm"
                    >
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-baseline gap-x-2">
                          <span className="font-mono font-medium">{p.pktNr}</span>
                          {p.deregistrerad && (
                            <Badge variant="outline" className="text-amber-700 border-amber-300">Avregistrerat</Badge>
                          )}
                          {!p.deregistrerad && p.avrapporterad && (
                            <Badge variant="outline" className="text-amber-700 border-amber-300">Avrapporterat</Badge>
                          )}
                          <span className="text-xs text-muted-foreground">
                            {[p.traslag, dim, p.langder.length ? `${p.langder.join("+")} dm` : null].filter(Boolean).join(" · ")}
                          </span>
                        </div>
                        <div className="text-xs text-muted-foreground truncate">
                          {[p.profil, p.kvalitet].filter(Boolean).join(" · ") || "—"} · {plats}
                        </div>
                      </div>
                      {redanSkannad && <Badge variant="secondary" className="shrink-0 text-[10px]">Redan skannad</Badge>}
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          {feedback && (
            <div className={cn(
              "flex items-center gap-2 text-sm",
              feedback.kind === "error" ? "text-destructive" : feedback.kind === "warn" ? "text-yellow-700" : "text-green-700",
            )}>
              {feedback.kind === "ok" ? <CheckCircle2 className="h-4 w-4 shrink-0" /> : <AlertCircle className="h-4 w-4 shrink-0" />}
              {feedback.text}
            </div>
          )}
        </div>

        <div className="rounded-lg border overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-muted/50">
              <tr>
                <th className="text-left px-4 py-2.5 font-medium text-muted-foreground">Paket-ID</th>
                <th className="text-left px-4 py-2.5 font-medium text-muted-foreground">Status</th>
                <th className="text-left px-4 py-2.5 font-medium text-muted-foreground">Antal / m³</th>
                <th className="text-left px-4 py-2.5 font-medium text-muted-foreground">Skannad</th>
                <th className="w-10 px-2 py-2.5"></th>
              </tr>
            </thead>
            <tbody>
              {session.skanningar.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-4 py-8 text-center text-muted-foreground">
                    Inga paket skannade ännu i denna inventering
                  </td>
                </tr>
              )}
              {session.skanningar.map((s) => (
                <tr key={s.id} className="border-t">
                  <td className="px-4 py-2.5 font-mono font-medium">
                    {s.pktNr}
                    {s.antalRader > 1 && <Badge variant="secondary" className="ml-2 font-normal">{s.antalRader} rader</Badge>}
                  </td>
                  <td className="px-4 py-2.5">
                    <Badge className={cn("border", KLASS_COLOR[s.klassificering])}>{KLASS_LABEL[s.klassificering]}</Badge>
                  </td>
                  <td className="px-4 py-2.5">{s.totalAntal} / {s.totalM3.toFixed(2)} m³</td>
                  <td className="px-4 py-2.5 text-xs text-muted-foreground">{new Date(s.skannadAt).toLocaleTimeString("sv-SE")}</td>
                  <td className="px-2 py-2.5 text-right">
                    <AlertDialog>
                      <AlertDialogTrigger asChild>
                        <button
                          type="button"
                          onClick={(e) => e.stopPropagation()}
                          disabled={tarBortPktNr === s.pktNr}
                          className="h-7 w-7 inline-flex items-center justify-center rounded-md text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors disabled:opacity-50"
                          title={`Ta bort ${s.pktNr} från inventeringen`}
                        >
                          {tarBortPktNr === s.pktNr ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <X className="h-3.5 w-3.5" />}
                        </button>
                      </AlertDialogTrigger>
                      <AlertDialogContent onClick={(e) => e.stopPropagation()}>
                        <AlertDialogHeader>
                          <AlertDialogTitle>Ta bort paket {s.pktNr} från denna inventering?</AlertDialogTitle>
                          <AlertDialogDescription>
                            Skanningen ångras och räknas inte längre i denna session. Paketets plats i lagret ändras inte.
                            {s.antalRader > 1 ? ` Samtliga ${s.antalRader} längdrader för paketet tas bort som en enhet.` : ""}
                          </AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                          <AlertDialogCancel>Avbryt</AlertDialogCancel>
                          <AlertDialogAction
                            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                            onClick={() => handleTaBortSkanning(s.pktNr)}
                          >
                            Ta bort
                          </AlertDialogAction>
                        </AlertDialogFooter>
                      </AlertDialogContent>
                    </AlertDialog>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <AlertDialog
        open={deregistreratPaket !== null}
        onOpenChange={(open) => {
          if (!open && !aterstaller) setDeregistreratPaket(null);
        }}
      >
        <AlertDialogContent onClick={(e) => e.stopPropagation()}>
          <AlertDialogHeader>
            <AlertDialogTitle>Paketet är avregistrerat</AlertDialogTitle>
            <AlertDialogDescription>
              Paket {deregistreratPaket?.pktNr} finns historiskt i Lager men är mjukraderat. Kontrollera uppgifterna innan du återinför det.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {deregistreratPaket && (
            <div className="rounded-md border bg-muted/30 p-3 text-sm space-y-1">
              <div><span className="font-medium">Paket:</span> <span className="font-mono">{deregistreratPaket.pktNr}</span></div>
              <div><span className="font-medium">Produkt:</span> {[deregistreratPaket.package.traslag, deregistreratPaket.package.profil, deregistreratPaket.package.kvalitet].filter(Boolean).join(" · ") || "—"}</div>
              <div><span className="font-medium">Dimension:</span> {deregistreratPaket.package.nomTjocklek ?? "—"}×{deregistreratPaket.package.nomBredd ?? "—"}</div>
              <div><span className="font-medium">Längder:</span> {deregistreratPaket.package.langder.join(", ") || "—"} dm</div>
              <div><span className="font-medium">Mängd:</span> {deregistreratPaket.package.styck} st · {deregistreratPaket.package.nomM3.toFixed(2)} m³</div>
              {!deregistreratPaket.kanAterstallas && (
                <p className="pt-2 text-destructive">{deregistreratPaket.restaureringsAnledning}</p>
              )}
              {deregistreratPaket.kanAterstallas && !isAdmin && (
                <p className="pt-2 text-amber-700">En administratör behöver återinföra paketet innan det kan inventeras.</p>
              )}
            </div>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={aterstaller}>Avbryt</AlertDialogCancel>
            {deregistreratPaket?.kanAterstallas && isAdmin && (
              <AlertDialogAction
                onClick={(event) => {
                  event.preventDefault();
                  handleAterstall();
                }}
                disabled={aterstaller}
                className="bg-[#2d5a27] hover:bg-[#224420] text-white"
              >
                {aterstaller && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                Återinför i lager
              </AlertDialogAction>
            )}
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {id && (
        <AvrapporteratPaketDialog
          sessionId={id}
          paket={avrapporteratPaket}
          arbetar={avrapporteratArbetar}
          onByt={handleByt}
          onAterinfor={handleAterinforAvrapporterat}
          onStang={() => { setAvrapporteratPaket(null); focusInput(); }}
        />
      )}

      {kameraOppen && (
        <KameraSkanner
          onPktNrFunnet={handlePktNrFranKamera}
          onOklarKod={handleOklarKodFranKamera}
          onClose={() => setKameraOppen(false)}
        />
      )}
    </div>
  );
}
