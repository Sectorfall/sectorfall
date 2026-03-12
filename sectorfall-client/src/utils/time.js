export function nowISO() { 
    return new Date().toISOString(); 
}

export function secondsFromNow(sec) { 
    return new Date(Date.now() + sec * 1000).toISOString(); 
}
