type Release = () => void;

const createConcurrencyGate = (limit: number) => {
  let active = 0;

  return {
    tryAcquire(): Release | undefined {
      if (active >= limit) return;

      active += 1;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        active -= 1;
      };
    },
  };
};

// A single Vercel instance should not launch several browsers and FFmpeg
// processes at once. This also bounds temporary-file and memory pressure.
export const generationGate = createConcurrencyGate(2);
