// Sound toggle for the guide video. The video starts muted so it can autoplay quietly.
const video = document.getElementById('guide');
const sound = document.getElementById('sound');

if (video && sound) {
  const sync = () => {
    sound.setAttribute('aria-pressed', String(!video.muted));
    sound.textContent = video.muted ? 'Sound off' : 'Sound on';
  };
  sound.addEventListener('click', () => {
    video.muted = !video.muted;
    if (!video.muted && video.paused) video.play().catch(() => {});
    sync();
  });
  video.addEventListener('volumechange', sync);
  sync();
}
