import request from 'supertest';
import { AlbumController } from 'src/controllers/album.controller.js';
import { Permission } from 'src/enum.js';
import { AlbumService } from 'src/services/album.service.js';
import { factory } from 'test/small.factory.js';
import { ControllerContext, controllerSetup, mockBaseService } from 'test/utils.js';

describe(AlbumController.name, () => {
  let ctx: ControllerContext;
  const service = mockBaseService(AlbumService);

  beforeAll(async () => {
    ctx = await controllerSetup(AlbumController, [{ provide: AlbumService, useValue: service }]);
    return () => ctx.close();
  });

  beforeEach(() => {
    service.resetAllMocks();
    ctx.reset();
  });

  describe('GET /albums', () => {
    it('should reject an invalid shared param', async () => {
      const { status, body } = await request(ctx.getHttpServer()).get('/albums?isShared=invalid');
      expect(status).toEqual(400);
      expect(body).toEqual(
        factory.responses.validationError([
          { path: ['isShared'], message: 'Invalid option: expected one of "true"|"false"' },
        ]),
      );
    });

    it('should reject an invalid assetId param', async () => {
      const { status, body } = await request(ctx.getHttpServer()).get('/albums?assetId=invalid');
      expect(status).toEqual(400);
      expect(body).toEqual(factory.responses.validationError([{ path: ['assetId'], message: 'Invalid UUID' }]));
    });
  });

  describe('GET /albums/names', () => {
    // a read-only API key (e.g. the public gateway's) must be able to load the Cmd+K album list
    it('should publish AlbumRead', async () => {
      service.getNames.mockResolvedValue([]);

      const { status } = await request(ctx.getHttpServer()).get('/albums/names');

      expect(status).toBe(200);
      expect(ctx.authenticate).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: expect.objectContaining({ permission: Permission.AlbumRead }),
        }),
      );
    });
  });
});
