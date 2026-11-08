import { useEffect, useState } from "preact/hooks";

export type Route =
  | { name: "discover" }
  | { name: "trader"; account: string }
  | { name: "portfolio" }
  | { name: "proof" }
  | { name: "missing"; path: string };

export function parse(hash: string): Route {
  const path = hash.replace(/^#/, "") || "/";
  const parts = path.split("/").filter(Boolean);
  if (parts.length === 0) return { name: "discover" };
  if (parts[0] === "t" && parts[1]) return { name: "trader", account: decodeURIComponent(parts[1]) };
  if (parts[0] === "portfolio") return { name: "portfolio" };
  if (parts[0] === "proof") return { name: "proof" };
  return { name: "missing", path };
}

export const href = {
  discover: "#/",
  trader: (a: string) => `#/t/${encodeURIComponent(a)}`,
  portfolio: "#/portfolio",
  proof: "#/proof",
};

export function navigate(to: string) {
  if (location.hash === to) return;
  location.hash = to;
}

export function useRoute(): Route {
  const [r, setR] = useState(() => parse(location.hash));
  useEffect(() => {
    const f = () => {
      setR(parse(location.hash));
      window.scrollTo({ top: 0 });
    };
    addEventListener("hashchange", f);
    return () => removeEventListener("hashchange", f);
  }, []);
  return r;
}
