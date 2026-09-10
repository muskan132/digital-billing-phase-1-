import { Test } from '@nestjs/testing';
import { APP_GUARD } from '@nestjs/core';
import { TemplatesService } from './templates.service';
import { PortalTemplatesController } from './portal-templates.controller';
import { MerchantContext } from '../auth/merchant-context';
import { SessionGuard } from '../auth/session.guard';
import { SessionService } from '../auth/session.service';

const CTX: MerchantContext = { userId: 'user-1', merchantId: 'merchant-A', role: 'MERCHANT_ADMIN' as never };

describe('PortalTemplatesController.list (W-2)', () => {
  it("passes the caller's own MerchantContext.merchantId through to TemplatesService.list() unmodified", async () => {
    const list = jest.fn().mockResolvedValue([]);
    const getDefaultTemplateId = jest.fn().mockResolvedValue(null);
    const controller = new PortalTemplatesController({ list, getDefaultTemplateId } as unknown as TemplatesService);

    await controller.list(CTX);

    expect(list).toHaveBeenCalledWith('merchant-A');
    expect(getDefaultTemplateId).toHaveBeenCalledWith('merchant-A');
  });

  it('marks exactly the template matching defaultTemplateId as isDefault, DTO fields trimmed from the raw row', async () => {
    const rawTemplates = [
      { id: 'tpl-1', name: 'Retail', billType: 'TAX_INVOICE', skeleton: 'RETAIL', version: 2, layoutSchema: { huge: 'blob' }, merchantId: 'merchant-A' },
      { id: 'tpl-2', name: 'Receipt', billType: 'RECEIPT', skeleton: 'MINIMALIST', version: 1, layoutSchema: { huge: 'blob' }, merchantId: null },
    ];
    const list = jest.fn().mockResolvedValue(rawTemplates);
    const getDefaultTemplateId = jest.fn().mockResolvedValue('tpl-1');
    const controller = new PortalTemplatesController({ list, getDefaultTemplateId } as unknown as TemplatesService);

    const result = await controller.list(CTX);

    expect(result.defaultTemplateId).toBe('tpl-1');
    expect(result.templates).toEqual([
      { id: 'tpl-1', name: 'Retail', billType: 'TAX_INVOICE', skeleton: 'RETAIL', version: 2, isDefault: true },
      { id: 'tpl-2', name: 'Receipt', billType: 'RECEIPT', skeleton: 'MINIMALIST', version: 1, isDefault: false },
    ]);
    // layoutSchema never leaves the controller — a dashboard list has no use for it.
    expect(result.templates.every((t) => !('layoutSchema' in t))).toBe(true);
  });

  it('returns isDefault: false for every template when the merchant has no default set', async () => {
    const list = jest.fn().mockResolvedValue([{ id: 'tpl-1', name: 'Retail', billType: 'TAX_INVOICE', skeleton: 'RETAIL', version: 1 }]);
    const getDefaultTemplateId = jest.fn().mockResolvedValue(null);
    const controller = new PortalTemplatesController({ list, getDefaultTemplateId } as unknown as TemplatesService);

    const result = await controller.list(CTX);
    expect(result.templates[0].isDefault).toBe(false);
    expect(result.defaultTemplateId).toBeNull();
  });

  it('returns an empty list, not an error, when the merchant has zero templates', async () => {
    const list = jest.fn().mockResolvedValue([]);
    const getDefaultTemplateId = jest.fn().mockResolvedValue(null);
    const controller = new PortalTemplatesController({ list, getDefaultTemplateId } as unknown as TemplatesService);

    const result = await controller.list(CTX);
    expect(result.templates).toEqual([]);
  });
});

describe('PortalTemplatesController — builder routes delegate to TemplatesService unmodified, merchantId from MerchantContext (W-3)', () => {
  function makeController(overrides: Partial<Record<string, jest.Mock>> = {}) {
    const service = {
      findOne: jest.fn().mockResolvedValue({ id: 'tpl-1' }),
      create: jest.fn().mockResolvedValue({ id: 'tpl-created' }),
      save: jest.fn().mockResolvedValue({ id: 'tpl-1-v2' }),
      saveAs: jest.fn().mockResolvedValue({ id: 'tpl-saved-as' }),
      setDefault: jest.fn().mockResolvedValue({ id: 'merchant-A' }),
      archive: jest.fn().mockResolvedValue({ id: 'tpl-1' }),
      deleteLineage: jest.fn().mockResolvedValue({ deletedCount: 1 }),
      ...overrides,
    };
    return { controller: new PortalTemplatesController(service as unknown as TemplatesService), service };
  }

  it('findOne(id, merchantId) — never a query param, never the seed', async () => {
    const { controller, service } = makeController();
    await controller.findOne('tpl-1', CTX);
    expect(service.findOne).toHaveBeenCalledWith('tpl-1', 'merchant-A');
  });

  it('save(id, body, merchantId)', async () => {
    const { controller, service } = makeController();
    const body = { layoutSchema: { blocks: [] } };
    await controller.save('tpl-1', body, CTX);
    expect(service.save).toHaveBeenCalledWith('tpl-1', body, 'merchant-A');
  });

  it('saveAs(id, body, merchantId)', async () => {
    const { controller, service } = makeController();
    const body = { name: 'Copy', layoutSchema: { blocks: [] } };
    await controller.saveAs('tpl-preset', body, CTX);
    expect(service.saveAs).toHaveBeenCalledWith('tpl-preset', body, 'merchant-A');
  });

  it('create(body, merchantId) — no template id', async () => {
    const { controller, service } = makeController();
    const body = { name: 'New', billType: 'RECEIPT', skeleton: 'MINIMALIST' };
    await controller.create(body, CTX);
    expect(service.create).toHaveBeenCalledWith(body, 'merchant-A');
  });

  it('setDefault(id, merchantId)', async () => {
    const { controller, service } = makeController();
    await controller.setDefault('tpl-1', CTX);
    expect(service.setDefault).toHaveBeenCalledWith('tpl-1', 'merchant-A');
  });

  it('archive(id, merchantId)', async () => {
    const { controller, service } = makeController();
    await controller.archive('tpl-1', CTX);
    expect(service.archive).toHaveBeenCalledWith('tpl-1', 'merchant-A');
  });

  it('deleteLineage(id, merchantId)', async () => {
    const { controller, service } = makeController();
    await controller.deleteLineage('tpl-1', CTX);
    expect(service.deleteLineage).toHaveBeenCalledWith('tpl-1', 'merchant-A');
  });
});

// D-59/D-50: the concrete proof this task exists for — the REAL controller,
// REAL SessionGuard, REAL Reflector, over real HTTP. Not the generic
// mechanism proof in session.guard.spec.ts — this is "STORE_STAFF hits a
// builder write route -> 403", the exact line A-3's roadmap row named and
// that shipped unenforced until D-59.
class FakeSessionServiceForRole {
  async findActiveSession(token: string) {
    return { user: { id: 'user-1', merchantId: 'merchant-A', type: 'EXTERNAL', role: token, disabledAt: null } };
  }
}

const FAKE_TEMPLATES_SERVICE = {
  list: async () => [],
  getDefaultTemplateId: async () => null,
  findOne: async () => ({ id: 'tpl-1' }),
  create: async () => ({ id: 'tpl-created' }),
  save: async () => ({ id: 'tpl-1-v2' }),
  saveAs: async () => ({ id: 'tpl-saved-as' }),
  deleteLineage: async () => ({ deletedCount: 1 }),
  setDefault: async () => ({ id: 'merchant-A' }),
  archive: async () => ({ id: 'tpl-1' }),
};

describe('PortalTemplatesController (structural — real Nest app, real SessionGuard, W-3)', () => {
  let app: import('@nestjs/common').INestApplication;
  let baseUrl: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [PortalTemplatesController],
      providers: [
        { provide: TemplatesService, useValue: FAKE_TEMPLATES_SERVICE },
        { provide: SessionService, useClass: FakeSessionServiceForRole },
        { provide: APP_GUARD, useClass: SessionGuard },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    await app.init();
    await app.listen(0);
    const address = app.getHttpServer().address();
    const port = typeof address === 'object' && address ? address.port : 0;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await app.close();
  });

  it('reads (list, findOne) accept BOTH MERCHANT_ADMIN and STORE_STAFF', async () => {
    for (const role of ['MERCHANT_ADMIN', 'STORE_STAFF']) {
      const list = await fetch(`${baseUrl}/portal/templates`, { headers: { cookie: `session=${role}` } });
      const findOne = await fetch(`${baseUrl}/portal/templates/tpl-1`, { headers: { cookie: `session=${role}` } });
      expect(list.status).toBe(200);
      expect(findOne.status).toBe(200);
    }
  });

  it('writes (create/save/save-as/set-default/archive/delete) accept MERCHANT_ADMIN...', async () => {
    const cookie = 'session=MERCHANT_ADMIN';
    const create = await fetch(`${baseUrl}/portal/templates`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'New', billType: 'RECEIPT', skeleton: 'MINIMALIST' }),
    });
    const save = await fetch(`${baseUrl}/portal/templates/tpl-1/save`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ layoutSchema: { blocks: [] } }),
    });
    const saveAs = await fetch(`${baseUrl}/portal/templates/tpl-1/save-as`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Copy', layoutSchema: { blocks: [] } }),
    });
    const setDefault = await fetch(`${baseUrl}/portal/templates/tpl-1/set-default`, { method: 'POST', headers: { cookie } });
    const archive = await fetch(`${baseUrl}/portal/templates/tpl-1/archive`, { method: 'POST', headers: { cookie } });
    const del = await fetch(`${baseUrl}/portal/templates/tpl-1`, { method: 'DELETE', headers: { cookie } });

    expect(create.status).toBe(201);
    expect(save.status).toBe(201);
    expect(saveAs.status).toBe(201);
    expect(setDefault.status).toBe(201);
    expect(archive.status).toBe(201);
    expect(del.status).toBe(200);
  });

  it('...and REJECT STORE_STAFF with 403 on every one of them — the A-3 verify line, now actually true', async () => {
    const cookie = 'session=STORE_STAFF';
    const create = await fetch(`${baseUrl}/portal/templates`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'New', billType: 'RECEIPT', skeleton: 'MINIMALIST' }),
    });
    const save = await fetch(`${baseUrl}/portal/templates/tpl-1/save`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ layoutSchema: { blocks: [] } }),
    });
    const saveAs = await fetch(`${baseUrl}/portal/templates/tpl-1/save-as`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Copy', layoutSchema: { blocks: [] } }),
    });
    const setDefault = await fetch(`${baseUrl}/portal/templates/tpl-1/set-default`, { method: 'POST', headers: { cookie } });
    const archive = await fetch(`${baseUrl}/portal/templates/tpl-1/archive`, { method: 'POST', headers: { cookie } });
    const del = await fetch(`${baseUrl}/portal/templates/tpl-1`, { method: 'DELETE', headers: { cookie } });

    expect(create.status).toBe(403);
    expect(save.status).toBe(403);
    expect(saveAs.status).toBe(403);
    expect(setDefault.status).toBe(403);
    expect(archive.status).toBe(403);
    expect(del.status).toBe(403);
  });
});
