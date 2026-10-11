describe('public gallery marker', () => {
  afterEach(() => {
    document.head.innerHTML = '';
    vi.resetModules();
  });

  const load = () => import('$lib/utils/public-gallery');

  it('is off without the marker, and allows everything', async () => {
    const { isPublicGallery, publicGalleryAllows } = await load();
    expect(isPublicGallery).toBe(false);
    expect(publicGalleryAllows('download')).toBe(true);
  });

  it('turns on with the marker and allows only the listed features', async () => {
    document.head.innerHTML = '<meta name="noodle-public-gallery" content="people map">';
    const { isPublicGallery, publicGalleryAllows } = await load();
    expect(isPublicGallery).toBe(true);
    expect(publicGalleryAllows('map')).toBe(true);
    expect(publicGalleryAllows('download')).toBe(false);
  });
});
