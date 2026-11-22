export function createCameraSession({
  getStream,
  onActive,
  onError,
}: {
  getStream: () => Promise<MediaStream>;
  onActive: (active: boolean) => void;
  onError: (message: string) => void;
}) {
  let stream: MediaStream | null = null;
  let video: HTMLVideoElement | null = null;
  let generation = 0;
  let starting = false;

  async function play() {
    const target = video;
    const currentStream = stream;
    if (!target || !currentStream) return;
    target.srcObject = currentStream;
    try {
      await target.play();
    } catch {
      if (video === target && stream === currentStream) {
        onError("Камерын дүрс тоглосонгүй. Камерыг дахин асаана уу.");
        stop();
      }
    }
  }

  function stop() {
    generation++;
    starting = false;
    const oldStream = stream;
    stream = null;
    oldStream?.getTracks().forEach((track) => { track.onended = null; track.stop(); });
    if (video) video.srcObject = null;
    onActive(false);
  }

  return {
    attach(target: HTMLVideoElement | null) {
      if (video && video !== target) video.srcObject = null;
      video = target;
      void play();
    },
    stop,
    async start() {
      if (starting) return;
      stop();
      const request = generation;
      starting = true;
      onError("");
      try {
        const next = await getStream();
        if (request !== generation) {
          next.getTracks().forEach((track) => track.stop());
          return;
        }
        stream = next;
        next.getVideoTracks().forEach((track) => {
          track.onended = () => {
            if (stream !== next) return;
            stop();
            onError("Камерын холболт тасарлаа. Камерыг дахин асаана уу.");
          };
        });
        onActive(true);
        await play();
      } catch {
        if (request !== generation) return;
        stop();
        onError("Камерт хандаж чадсангүй. Зөвшөөрөл болон өөр апп камер ашиглаж байгаа эсэхийг шалгана уу.");
      } finally {
        if (request === generation) starting = false;
      }
    },
  };
}
