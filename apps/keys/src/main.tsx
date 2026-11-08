import "@fontsource/inter-tight/latin-400.css";
import "@fontsource/inter-tight/latin-500.css";
import "./styles.css";
import { render } from "preact";
import { useEffect } from "preact/hooks";
import { Footer, Header, NoticeToast, OfflineBanner } from "./components/Shell";
import { Empty, IArrow } from "./components/ui";
import { WalletModal } from "./components/WalletModal";
import { href, useRoute } from "./lib/router";
import { initWallet } from "./state/actions";
import { boot } from "./state/store";
import { Discover } from "./views/Discover";
import { Portfolio } from "./views/Portfolio";
import { Proof } from "./views/Proof";
import { Trader } from "./views/Trader";

function App() {
  const route = useRoute();
  useEffect(() => {
    boot();
    initWallet();
  }, []);
  useEffect(() => {
    document.title = route.name === "trader" ? `${route.account} · Polypus Keys` : route.name === "portfolio" ? "Portfolio · Polypus Keys" : route.name === "proof" ? "Proof · Polypus Keys" : "Polypus Keys";
  }, [route]);

  return (
    <>
      <a class="skip" href="#main">Skip to content</a>
      <Header route={route} />
      <OfflineBanner />
      {route.name === "discover" && <Discover />}
      {route.name === "trader" && <Trader key={route.account} account={route.account} />}
      {route.name === "portfolio" && <Portfolio />}
      {route.name === "proof" && <Proof />}
      {route.name === "missing" && (
        <main class="page wrap" id="main">
          <Empty title="Nothing here" action={<a class="btn btn--line" href={href.discover}>Back to traders <IArrow size={12} /></a>}>No page at {route.path}.</Empty>
        </main>
      )}
      <Footer />
      <WalletModal />
      <NoticeToast />
    </>
  );
}

document.documentElement.classList.add("js");
render(<App />, document.getElementById("app")!);
