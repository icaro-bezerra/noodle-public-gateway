import request from 'supertest';
import { GalleryMapController } from 'src/controllers/gallery-map.controller.js';
import { Permission } from 'src/enum.js';
import { SharedSpaceService } from 'src/services/shared-space.service.js';
import { ControllerContext, controllerSetup, mockBaseService } from 'test/utils.js';

describe(GalleryMapController.name, () => {
  let ctx: ControllerContext;
  const service = mockBaseService(SharedSpaceService);

  beforeAll(async () => {
    ctx = await controllerSetup(GalleryMapController, [{ provide: SharedSpaceService, useValue: service }]);
    return () => ctx.close();
  });

  beforeEach(() => {
    service.resetAllMocks();
    ctx.reset();
  });

  describe('GET /gallery/map/markers', () => {
    // a read-only API key (e.g. the public gateway's) must be able to load the album map
    it('should publish MapRead', async () => {
      service.getFilteredMapMarkers.mockResolvedValue([]);

      const { status } = await request(ctx.getHttpServer()).get('/gallery/map/markers');

      expect(status).toBe(200);
      expect(ctx.authenticate).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: expect.objectContaining({ permission: Permission.MapRead }),
        }),
      );
    });
  });
});
