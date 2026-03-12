import { ShipManager } from "./shipManager.js";

export const DroneManager = {
	async updateDroneState(ship, drones) {
    	ship.drones = drones;
    	await ShipManager.saveShip(ship);
	}
};
