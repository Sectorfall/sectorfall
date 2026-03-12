export class Joystick {
    constructor(container) {
        this.container = container;
        this.base = document.createElement('div');
        this.stick = document.createElement('div');
        
        this.active = false;
        this.input = { x: 0, y: 0 };
        this.maxRadius = 50;

        this.setupStyles();
        this.setupEvents();
        
        container.appendChild(this.base);
    }

    setupStyles() {
        Object.assign(this.base.style, {
            position: 'absolute',
            bottom: '50px',
            left: '50px',
            width: '100px',
            height: '100px',
            backgroundColor: 'rgba(255, 255, 255, 0.2)',
            borderRadius: '50%',
            touchAction: 'none',
            display: 'none' // Hidden by default, shown via GameManager if mobile
        });

        Object.assign(this.stick.style, {
            position: 'absolute',
            top: '25px',
            left: '25px',
            width: '50px',
            height: '50px',
            backgroundColor: 'rgba(255, 255, 255, 0.5)',
            borderRadius: '50%',
            transition: 'transform 0.1s ease-out'
        });

        this.base.appendChild(this.stick);
    }

    show() {
        this.base.style.display = 'block';
    }

    setupEvents() {
        const handleStart = (e) => {
            this.active = true;
            this.handleMove(e);
        };

        const handleMove = (e) => {
            if (!this.active) return;
            this.handleMove(e);
        };

        const handleEnd = () => {
            this.active = false;
            this.input = { x: 0, y: 0 };
            this.stick.style.transform = 'translate(0, 0)';
        };

        this.base.addEventListener('pointerdown', handleStart);
        window.addEventListener('pointermove', handleMove);
        window.addEventListener('pointerup', handleEnd);
    }

    handleMove(e) {
        const rect = this.base.getBoundingClientRect();
        const centerX = rect.left + rect.width / 2;
        const centerY = rect.top + rect.height / 2;
        
        let dx = e.clientX - centerX;
        let dy = e.clientY - centerY;
        
        const distance = Math.sqrt(dx * dx + dy * dy);
        
        if (distance > this.maxRadius) {
            dx = (dx / distance) * this.maxRadius;
            dy = (dy / distance) * this.maxRadius;
        }

        this.input.x = dx / this.maxRadius;
        this.input.y = -dy / this.maxRadius; // Invert Y for game coords

        this.stick.style.transform = `translate(${dx}px, ${dy}px)`;
    }

    getVector() {
        return this.input;
    }
}
