import React from "react";
import { Composition } from "remotion";
import { loadFont } from "@remotion/google-fonts/FiraCode";
import { Promo, TOTAL_FRAMES } from "./Promo";
import { fetchLiveData, FALLBACK, type LiveData } from "./lib/api";

loadFont();

const FPS = 30;

export const RemotionRoot: React.FC = () => {
  return (
    <Composition
      id="VaultPromo"
      component={Promo}
      durationInFrames={TOTAL_FRAMES}
      fps={FPS}
      width={1920}
      height={1080}
      defaultProps={{ live: FALLBACK }}
      // Pull live metrics + PnL series at render time (Studio and CLI both run
      // this). Falls back to the baked-in snapshot if the API is unreachable.
      calculateMetadata={async () => {
        const live: LiveData = await fetchLiveData();
        return { props: { live } };
      }}
    />
  );
};
